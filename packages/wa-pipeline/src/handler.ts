import {
  buildRuntimeTurn,
  createInitialProfile,
  summarizeLead,
  transcribeAudio
} from "@jazu/ai";
import { prisma as defaultPrisma, type Prisma } from "@jazu/db";
import {
  actionButtonSchema,
  businessProfileSchema,
  type ActionButton,
  type Carcass
} from "@jazu/shared";
import { getLeadNotifyQueue } from "@jazu/queue";
import { sendTelegramLead, sendWhatsappOwnerNotification } from "./notifications.js";
import { trackConversationUsage, type UsageView } from "./billing.js";
import { buildLlmTelemetry } from "./llm-telemetry.js";
import { resolveLeadPhones } from "./phone.js";

type PrismaClient = typeof defaultPrisma;

/**
 * Универсальный обработчик входящего WhatsApp-сообщения.
 *
 * Используется ИЗ:
 *   - apps/jobs (BullMQ consumer для wa:inbound) — production path;
 *   - apps/api /api/whatsapp/inbound — legacy/fallback path для случаев,
 *     когда воркер не может ходить в Redis (например, локальная отладка
 *     без bullmq) или для внешних вебхуков.
 *
 * Принципы:
 *   - идемпотентность: при повторной обработке того же waMessageId возвращает
 *     deduplicated: true без LLM-вызова и без списания квоты;
 *   - dedupe квоты делается ВНУТРИ trackConversationUsage по chatId+period;
 *   - функция НЕ отправляет сообщение в WhatsApp; consumer сам решит — либо
 *     enqueue в wa:outbound (production), либо положить ответ в HTTP-ответ
 *     (legacy).
 */

export type WaInboundInput = {
  agentId: string;
  chatId: string;
  senderName?: string;
  /**
   * Реальный телефон клиента (только цифры), резолвнутый воркером из ключа
   * сообщения. Нужен, потому что для WhatsApp-LID чатов chatId — это не номер.
   * Если не пришёл (старый воркер / PN-чат) — фолбэк на chatId в resolveLeadPhones.
   */
  senderPhone?: string;
  message: string;
  /**
   * Голосовое сообщение: байты media в base64. Если message пустой, а это поле
   * заполнено — распознаём через transcribeAudio (после dedupe/квоты).
   */
  audioBase64?: string;
  /** MIME аудио (обычно "audio/ogg; codecs=opus"). */
  audioMimeType?: string;
  waMessageId?: string;
  /**
   * Если передан — проверяется, что текущий WaConnection.workerSessionId
   * совпадает. Защита от race-condition при перепривязке WA-аккаунта.
   */
  workerSessionId?: string;
  /**
   * Unix-секунды (Baileys.message.messageTimestamp). Если у WaConnection
   * выставлен botRespondsSince, сообщения с timestamp до этой отсечки
   * считаются «доконнектными» — бот их игнорирует и не сохраняет.
   * Это история-sync flood при подключении.
   */
  messageTimestamp?: number;
};

export type WaInboundResult =
  | {
      status: "ok";
      reply: string;
      summary: string;
      leadId: string | null;
      conversationId: string;
      shouldHandoff: boolean;
      actionButton?: ActionButton | undefined;
      usage?: UsageView | undefined;
      /** Владелец агента (для аналитики lead_created в jobs). null у
       *  анонимных агентов без привязанного юзера. */
      agentOwnerUserId: string | null;
      /** Был ли это первый outbound бота в чате (до persist текущего ответа). */
      isFirstBotReply: boolean;
    }
  | {
      status: "deduplicated";
      conversationId: string;
    }
  | {
      status: "agent_not_found";
    }
  | {
      status: "worker_session_mismatch";
    }
  | {
      status: "quota_exhausted";
      usage: UsageView | undefined;
    }
  | {
      status: "bot_loop_protected";
      conversationId: string;
      outboundLastHour: number;
    }
  | {
      status: "bot_paused";
    }
  | {
      /**
       * Сообщение или чат старше отсечки `WaConnection.botRespondsSince`.
       * Бот не отвечает, сообщение НЕ сохраняем, квоту НЕ списываем.
       * Случается:
       *   - история-sync при первом подключении (старые непрочитанные
       *     от друзей за последний месяц);
       *   - реальный inbound в чате, который существовал до подключения.
       */
      status: "pre_connection_message";
    };

export type WaInboundOptions = {
  prisma?: PrismaClient;
  telegramBotToken?: string | undefined;
  /**
   * URL wa-worker (env.WA_WORKER_URL) + internal-токен. Нужны, чтобы при
   * новом лиде отправить владельцу уведомление в WhatsApp через его же бота.
   * Если не переданы — WA-уведомление не отправляется (Telegram-канал
   * по-прежнему работает независимо).
   */
  workerUrl?: string | undefined;
  internalToken?: string | undefined;
  /**
   * Bot-loop protection: если за последний час бот уже ответил этому chatId
   * больше N раз — пропускаем без LLM-вызова. Защищает от бесконечного
   * «бот → бот» цикла и от спам-ботов на стороне клиента.
   * По умолчанию 30 (норма ~5-10 ответов в час даже у активного диалога).
   */
  botLoopMaxRepliesPerHour?: number;
  /**
   * Задержка перед отправкой карточки лида владельцу (мс). Карточку придерживаем,
   * чтобы поймать «номер для связи», названный сразу после закрытия, и отправить
   * ОДНУ полную карточку. По умолчанию 120000 (2 мин). См. notifyLeadById.
   */
  leadNotifyDelayMs?: number | undefined;
};

const DEFAULT_BOT_LOOP_LIMIT = 30;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function toAssistantParts(text: string, actionButton?: unknown) {
  const parts: Array<{ type: string; text?: string; action_button?: ActionButton }> = [
    { type: "text", text }
  ];
  if (actionButton) {
    parts.push({ type: "action_button", action_button: actionButtonSchema.parse(actionButton) });
  }
  return parts;
}

async function getOrCreateConversation(prisma: PrismaClient, agentId: string, chatId: string, customerName?: string) {
  const updateData: {
    customerName?: string | null;
    lastMessageAt: Date;
    status: "open";
  } = {
    lastMessageAt: new Date(),
    status: "open"
  };
  if (customerName !== undefined) {
    updateData.customerName = customerName;
  }
  return prisma.conversation.upsert({
    where: { agentId_waChatId: { agentId, waChatId: chatId } },
    update: updateData,
    create: {
      agentId,
      waChatId: chatId,
      customerName: customerName ?? null,
      status: "open",
      lastMessageAt: new Date()
    }
  });
}

type HandoffType = "hot_lead" | "complaint" | "out_of_scope" | "requested" | null;

// Заголовок уведомления зависит от типа передачи: жалоба и горячий лид
// требуют более явного/срочного сигнала владельцу, чем стандартная передача.
function handoffNotificationTitle(handoffType: HandoffType): { plain: string; html: string } {
  switch (handoffType) {
    case "hot_lead":
      return { plain: "🔥 Горячий лид", html: "<b>🔥 Горячий лид</b>" };
    case "complaint":
      return { plain: "⚠️ Жалоба - срочно", html: "<b>⚠️ Жалоба - срочно</b>" };
    case "out_of_scope":
      return { plain: "❓ Нестандартный вопрос", html: "<b>❓ Нестандартный вопрос</b>" };
    case "requested":
      return { plain: "📞 Просят менеджера", html: "<b>📞 Просят менеджера</b>" };
    default:
      return { plain: "🔔 Новый лид", html: "<b>Новый лид</b>" };
  }
}

// Ранг срочности типа передачи (выше = срочнее). Нужен, чтобы при повторном
// handoff в уже открытом лиде понять, «дозрел» ли клиент (например
// out_of_scope → hot_lead) и стоит ли повторно дёрнуть владельца.
const handoffRank: Record<string, number> = {
  out_of_scope: 1,
  requested: 2,
  hot_lead: 3,
  // complaint срочнее hot_lead: жалоба ПОСЛЕ горячего лида должна повторно
  // уведомить владельца (конфликт важнее продажи). Обратная сторона: hot_lead
  // после complaint не эскалирует — но раньше при равенстве 3=3 он тоже молчал.
  complaint: 4
};

// Лейбл «Агент» на карточке лида: имя агента у владельцев не настраивается
// (стандартное значение), поэтому показываем единый брендовый лейбл.
const LEAD_CARD_AGENT_LABEL = "jazu.chat";

// LLM иногда префиксует summary ярлыком типа («Горячий лид: …»), который и так
// есть в заголовке карточки. Срезаем дубль, сохраняя маркер «[имя не указано]».
function formatLeadSummary(summary: string): string {
  const noName = /^\[имя не указано\]\s*/;
  const hasNoName = noName.test(summary);
  const body = summary
    .replace(noName, "")
    .replace(
      /^(?:🔥|⚠️|❓|📞|🔔)?\s*(?:Горячий лид|Жалоба(?:\s*-\s*срочно)?|Нестандартный вопрос|Просят менеджера|Новый лид)\s*:\s*/i,
      ""
    )
    .trim();
  return hasNoName ? `[имя не указано] ${body}` : body;
}

// Отправка уведомлений владельцу о лиде/эскалации. Вынесено из writeLeadIfNeeded,
// чтобы переиспользовать и в ветке создания нового лида, и при эскалации
// существующего. Сам грузит agent (с user/waConnections) по agentId.
async function sendHandoffNotification(
  prisma: PrismaClient,
  agentId: string,
  summary: string,
  handoffType: HandoffType,
  whatsappPhone: string | null,
  contactPhone: string | null,
  options: WaInboundOptions
): Promise<void> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { user: true, waConnections: { orderBy: { createdAt: "desc" }, take: 1 } }
  });

  const title = handoffNotificationTitle(handoffType);
  const leadLine = `Данные лида: ${formatLeadSummary(summary)}`;
  const notificationLines = [
    title.plain,
    leadLine,
    ...(whatsappPhone ? [`Номер WhatsApp: ${whatsappPhone}`] : []),
    ...(contactPhone ? [`Номер для связи: ${contactPhone}`] : []),
    `Агент: ${LEAD_CARD_AGENT_LABEL}`
  ];

  // Канал 1 (основной): WhatsApp на личный номер владельца через его бота.
  // Шлём только если бот подключён (есть activный WaConnection) и у юзера
  // указан личный номер. Если личный номер == номер бота — уйдёт «себе».
  const waConnection = agent?.waConnections?.[0];
  if (
    agent?.user?.phone &&
    waConnection?.status === "connected" &&
    options.workerUrl &&
    options.internalToken
  ) {
    void sendWhatsappOwnerNotification({
      workerUrl: options.workerUrl,
      internalToken: options.internalToken,
      agentId: agent.id,
      personalPhone: agent.user.phone,
      botPhone: waConnection.phone,
      text: notificationLines.join("\n\n")
    });
  }

  // Канал 2 (опциональный, независимый): Telegram, если указан chat id.
  if (agent?.user?.telegramChatId) {
    void sendTelegramLead(
      options.telegramBotToken,
      agent.user.telegramChatId,
      [title.html, leadLine, ...(whatsappPhone ? [`Номер WhatsApp: ${whatsappPhone}`] : []), ...(contactPhone ? [`Номер для связи: ${contactPhone}`] : []), `Агент: ${LEAD_CARD_AGENT_LABEL}`].join("\n")
    );
  }
}

// Дефолтная задержка отправки карточки лида (мс). Переопределяется
// options.leadNotifyDelayMs (env LEAD_NOTIFY_DELAY_MS в jobs). 2 минуты.
const DEFAULT_LEAD_NOTIFY_DELAY_MS = 120_000;

// Дебаунсим карточку ТОЛЬКО для горячего лида: там есть подтверждение номера
// («по этому номеру?»), и клиент может назвать «номер для связи» сразу после
// закрытия — придержка ловит его в одну карточку. Остальные типы (жалоба,
// нестандартный вопрос, просят менеджера, общий) срочные и без позднего номера —
// шлём сразу.
function shouldDebounceLeadCard(handoffType: HandoffType): boolean {
  return handoffType === "hot_lead";
}

async function writeLeadIfNeeded(
  prisma: PrismaClient,
  agentId: string,
  conversationId: string,
  summary: string,
  message: string,
  shouldCreate: boolean,
  options: WaInboundOptions,
  handoffType: HandoffType = null,
  whatsappPhone: string | null = null,
  contactPhone: string | null = null
): Promise<string | null> {
  if (!shouldCreate) return null;
  const existing = await prisma.lead.findFirst({
    where: { conversationId, status: "new" }
  });
  if (existing) {
    // Лид уже открыт. Если клиент «дозрел» (новый тип передачи срочнее
    // сохранённого) — повышаем тип у лида и ПОВТОРНО уведомляем владельца.
    // На равный/менее срочный тип молчим, чтобы не спамить на каждое сообщение.
    const prevFields = (existing.fields as Record<string, unknown> | null) ?? {};
    const prevType = typeof prevFields.handoffType === "string" ? prevFields.handoffType : null;
    const prevRank = prevType ? (handoffRank[prevType] ?? 0) : 0;
    const newRank = handoffType ? (handoffRank[handoffType] ?? 0) : 0;
    if (newRank > prevRank) {
      // Шлём сейчас, если карточка уже ушла (догоняем эскалацию) ИЛИ новый тип не
      // дебаунсится (напр. hot_lead → жалоба: жалоба срочная, нельзя ждать
      // отложенную карточку). Иначе — оставляем отложенному заданию.
      const sendNow = prevFields.notified === true || !shouldDebounceLeadCard(handoffType);
      await prisma.lead.update({
        where: { id: existing.id },
        data: {
          fields: {
            ...prevFields,
            ...(handoffType ? { handoffType } : {}),
            ...(whatsappPhone ? { whatsappPhone } : {}),
            ...(contactPhone ? { contactPhone } : {}),
            ...(sendNow ? { notified: true, notifiedAt: new Date().toISOString() } : {}),
            escalatedAt: new Date().toISOString()
          }
        }
      });
      // sendNow помечает notified=true → отложенное задание (если было) потом no-op.
      if (sendNow) {
        await sendHandoffNotification(prisma, agentId, summary, handoffType, whatsappPhone, contactPhone, options);
      }
    }
    return existing.id;
  }

  const lead = await prisma.lead.create({
    data: {
      conversationId,
      summary,
      niche: null,
      fields: {
        sourceMessage: message,
        createdAt: new Date().toISOString(),
        // Мгновенные типы помечаем notified сразу (карточка уходит ниже инлайн);
        // дебаунсится только hot_lead.
        notified: !shouldDebounceLeadCard(handoffType),
        ...(handoffType ? { handoffType } : {}),
        ...(whatsappPhone ? { whatsappPhone } : {}),
        ...(contactPhone ? { contactPhone } : {})
      },
      status: "new"
    }
  });

  if (shouldDebounceLeadCard(handoffType)) {
    // hot_lead: карточку НЕ шлём сразу — придерживаем ~2 мин, чтобы поймать «номер
    // для связи» (его называют сразу после закрытия) и отправить ОДНУ полную
    // карточку. jobId = lead.id (cuid) → одно задание на лид, БЕЗ ':' (BullMQ не
    // рекомендует двоеточие в jobId). Отправит notifyLeadById (consumer в jobs).
    const delayMs = options.leadNotifyDelayMs ?? DEFAULT_LEAD_NOTIFY_DELAY_MS;
    await getLeadNotifyQueue().add(
      "lead-notify",
      { leadId: lead.id, agentId },
      { delay: delayMs, jobId: lead.id }
    );
  } else {
    // Жалоба / нестандартный вопрос / просят менеджера / общий лид — срочные, без
    // flow с поздним «номером для связи». Шлём карточку владельцу сразу.
    await sendHandoffNotification(prisma, agentId, summary, handoffType, whatsappPhone, contactPhone, options);
  }

  return lead.id;
}

// Номер для связи, названный ПОСЛЕ закрытия лида, дописываем в открытый лид МОЛЧА
// (без отправки): если карточка ещё в окне задержки — отложенное задание подхватит
// номер и пришлёт ОДНУ полную карточку; если карточка уже ушла — номер останется на
// записи лида (виден в кабинете), второй карточкой владельца НЕ спамим.
async function updateOpenLeadContactPhone(
  prisma: PrismaClient,
  conversationId: string,
  whatsappPhone: string | null,
  contactPhone: string | null
): Promise<void> {
  if (!contactPhone) return;
  const lead = await prisma.lead.findFirst({
    where: { conversationId, status: "new" },
    orderBy: { createdAt: "desc" }
  });
  if (!lead) return;
  const fields = (lead.fields as Record<string, unknown> | null) ?? {};
  if (fields.contactPhone === contactPhone) return; // уже записан — ничего не делаем
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      fields: {
        ...fields,
        contactPhone,
        ...(whatsappPhone ? { whatsappPhone } : {}),
        contactPhoneUpdatedAt: new Date().toISOString()
      }
    }
  });
}

// Отправка карточки лида владельцу по leadId — вызывается из отложенного задания
// lead-notify (через ~2 мин после закрытия). К этому моменту в lead.fields уже
// собрано всё (включая «номер для связи»), поэтому карточка одна и полная.
// Идемпотентно: если карточка уже отправлена (fields.notified) — выходим.
export async function notifyLeadById(
  prisma: PrismaClient,
  leadId: string,
  agentId: string,
  options: WaInboundOptions
): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;
  const fields = (lead.fields as Record<string, unknown> | null) ?? {};
  if (fields.notified === true) return; // уже отправлено — не дублируем
  const handoffType = typeof fields.handoffType === "string" ? (fields.handoffType as HandoffType) : null;
  const whatsappPhone = typeof fields.whatsappPhone === "string" ? fields.whatsappPhone : null;
  const contactPhone = typeof fields.contactPhone === "string" ? fields.contactPhone : null;
  await sendHandoffNotification(prisma, agentId, lead.summary, handoffType, whatsappPhone, contactPhone, options);
  await prisma.lead.update({
    where: { id: leadId },
    data: { fields: { ...fields, notified: true, notifiedAt: new Date().toISOString() } }
  });
}

export async function processWaInbound(
  input: WaInboundInput,
  options: WaInboundOptions = {}
): Promise<WaInboundResult> {
  const prisma = options.prisma ?? defaultPrisma;

  if (input.workerSessionId) {
    const conn = await prisma.waConnection.findUnique({ where: { agentId: input.agentId } });
    if (!conn || !conn.workerSessionId || conn.workerSessionId !== input.workerSessionId) {
      return { status: "worker_session_mismatch" };
    }
  }

  const agent = await prisma.agent.findUnique({
    where: { id: input.agentId },
    include: { businessProfile: true, user: true }
  });
  if (!agent) return { status: "agent_not_found" };

  // Глобальный «выключатель» бота: владелец агента может поставить бот на паузу
  // на странице «Диалоги». В этом режиме мы НЕ сохраняем inbound, НЕ списываем
  // квоту, НЕ дёргаем LLM — будто бота вообще нет. Сообщение клиента
  // фактически потеряется (что и хотел владелец).
  if (!agent.botEnabled) {
    return { status: "bot_paused" };
  }

  // Фильтр «бот отвечает только на сообщения после подключения».
  // Защищает от:
  //   1) history-sync flood: WhatsApp при connection шлёт пачку старых
  //      непрочитанных сообщений за последний месяц. messageTimestamp у них
  //      в прошлом — отсекаем по нему.
  //   2) Вторжения бота в чаты, которые шли вне его. Если Conversation
  //      существовал до подключения (например, юзер раньше уже был привязан),
  //      бот не должен туда лезть.
  // Если botRespondsSince=NULL — фильтр выключен (legacy / dev).
  const waConnection = await prisma.waConnection.findUnique({
    where: { agentId: agent.id },
    select: { botRespondsSince: true }
  });
  const respondsSince = waConnection?.botRespondsSince ?? null;
  if (respondsSince) {
    if (input.messageTimestamp !== undefined) {
      const msgDate = new Date(input.messageTimestamp * 1000);
      if (msgDate < respondsSince) {
        return { status: "pre_connection_message" };
      }
    }
    const existingConversation = await prisma.conversation.findUnique({
      where: { agentId_waChatId: { agentId: agent.id, waChatId: input.chatId } },
      select: { createdAt: true }
    });
    if (existingConversation && existingConversation.createdAt < respondsSince) {
      return { status: "pre_connection_message" };
    }
  }

  // Главный фильтр старых диалогов: чат был в WhatsApp ДО подключения
  // (снят из history-sync в WaPreConnectionChat). Ловит даже те старые
  // чаты, которых ещё нет в нашей Conversation — клиент написал в них
  // впервые после подключения свежим сообщением (messageTimestamp и
  // Conversation.createdAt в этом случае фильтр выше не отсекают).
  // Работает независимо от botRespondsSince — снимок и есть точка отсчёта.
  const preConnectionChat = await prisma.waPreConnectionChat.findUnique({
    where: { agentId_waChatId: { agentId: agent.id, waChatId: input.chatId } },
    select: { id: true }
  });
  if (preConnectionChat) {
    return { status: "pre_connection_message" };
  }

  const profile = agent.businessProfile
    ? businessProfileSchema.parse(agent.businessProfile.data)
    : createInitialProfile();

  const trackResult = await trackConversationUsage(prisma, {
    agentOwnerUserId: agent.userId ?? null,
    agentId: agent.id,
    chatId: input.chatId
  });
  if (!trackResult.ok && trackResult.reason === "exhausted") {
    return { status: "quota_exhausted", usage: trackResult.usage };
  }

  const activePromptVersion = await prisma.promptVersion.findFirst({
    where: { agentId: agent.id },
    orderBy: { createdAt: "desc" }
  });
  const systemOverride = activePromptVersion?.content || agent.currentPrompt || null;

  const conversation = await getOrCreateConversation(prisma, agent.id, input.chatId, input.senderName);

  if (input.waMessageId) {
    const dup = await prisma.waMessage.findFirst({
      where: {
        conversationId: conversation.id,
        waMsgId: input.waMessageId,
        direction: "in"
      }
    });
    if (dup) {
      return { status: "deduplicated", conversationId: conversation.id };
    }
  }

  // Голосовое сообщение: текста нет, но есть аудио → распознаём. Делаем ПОСЛЕ
  // dedupe, чтобы не платить за STT по дублям. Внутри transcribeAudio —
  // Gemini → OpenAI fallback. Лимитов по длине нет: принимаем любое аудио.
  const audioBase64 = input.audioBase64;
  const isVoiceMessage = !input.message.trim() && Boolean(audioBase64);
  let messageText = input.message;
  if (isVoiceMessage && audioBase64) {
    try {
      const audioBytes = Buffer.from(audioBase64, "base64");
      messageText = (
        await transcribeAudio(audioBytes, {
          mimeType: input.audioMimeType || "audio/ogg",
          filename: "voice.ogg"
        })
      ).trim();
    } catch (err) {
      console.error("[wa-inbound] voice transcription failed", err);
      messageText = "";
    }
  }

  // Распознать не удалось (битое/пустое аудио или оба STT-провайдера упали).
  // Сохраняем входящее как голосовое и мягко просим текстом — вместо тишины
  // бота. LLM не дёргаем (нечего обрабатывать).
  if (isVoiceMessage && !messageText) {
    const priorOutbound = await prisma.waMessage.count({
      where: { conversationId: conversation.id, direction: "out" }
    });
    await prisma.waMessage.create({
      data: {
        conversationId: conversation.id,
        direction: "in",
        body: "[голосовое сообщение]",
        waMsgId: input.waMessageId ?? null,
        parts: jsonInput([{ type: "text", text: "[голосовое сообщение]" }])
      }
    });
    const fallbackReply =
      "Извините, не получилось распознать голосовое. Напишите, пожалуйста, текстом.";
    await prisma.waMessage.create({
      data: {
        conversationId: conversation.id,
        direction: "out",
        body: fallbackReply,
        parts: jsonInput(toAssistantParts(fallbackReply, undefined))
      }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        customerName: input.senderName ?? conversation.customerName,
        lastMessageAt: new Date(),
        status: "open"
      }
    });
    return {
      status: "ok",
      reply: fallbackReply,
      summary: "",
      leadId: null,
      conversationId: conversation.id,
      shouldHandoff: false,
      agentOwnerUserId: agent.userId ?? null,
      isFirstBotReply: priorOutbound === 0
    };
  }

  // Bot-loop protection: считаем outbound за последний час по этому чату.
  // Если бот уже отбомбил > лимита — молчим. Один inbound при этом всё равно
  // сохраним в БД, чтобы было видно «вот тут начался цикл».
  const botLoopLimit = options.botLoopMaxRepliesPerHour ?? DEFAULT_BOT_LOOP_LIMIT;
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const outboundLastHour = await prisma.waMessage.count({
    where: {
      conversationId: conversation.id,
      direction: "out",
      createdAt: { gte: hourAgo }
    }
  });

  await prisma.waMessage.create({
    data: {
      conversationId: conversation.id,
      direction: "in",
      body: messageText,
      waMsgId: input.waMessageId ?? null,
      parts: jsonInput([{ type: "text", text: messageText }])
    }
  });

  if (outboundLastHour >= botLoopLimit) {
    return {
      status: "bot_loop_protected",
      conversationId: conversation.id,
      outboundLastHour
    };
  }

  const priorOutboundCount = await prisma.waMessage.count({
    where: {
      conversationId: conversation.id,
      direction: "out"
    }
  });
  const isFirstBotReply = priorOutboundCount === 0;

  const history = await prisma.waMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: 20
  });
  history.reverse();

  const telemetry = buildLlmTelemetry({
    prisma,
    route: "wa-inbound",
    userId: agent.userId ?? null,
    agentId: agent.id
  });

  // РОЛЬ/КАРКАС берём из authoritative-источника (Agent), а не из профиля:
  // BusinessProfile.data может отставать, а envelope читает profile.carcass/botModel.
  const runtimeProfile = {
    ...profile,
    carcass: (agent.carcass ?? null) as Carcass | null,
    botModel: (agent.botModel ?? null) as
      | "admin" | "consultant" | "support" | "qualifier" | "salesman" | null
  } as typeof profile;

  const runtimeTurn = await buildRuntimeTurn(
    runtimeProfile,
    messageText,
    history
      .slice(0, -1)
      .map((item) => ({
        role: item.direction === "out" ? "assistant" : "user",
        content: item.body
      })),
    {
      systemOverride,
      detectedNeed: conversation.detectedNeed,
      detectedName: conversation.detectedName,
      telemetry
    }
  );

  // Буфер потребности: needChanged-перезапись проверяем ПЕРВОЙ, иначе при уже
  // заполненном detectedNeed смена запроса клиентом не записалась бы.
  {
    let nextNeed: string | null = null;
    if (runtimeTurn.needChanged && runtimeTurn.extractedNeed) {
      nextNeed = runtimeTurn.extractedNeed;
    } else if (!conversation.detectedNeed && runtimeTurn.extractedNeed) {
      nextNeed = runtimeTurn.extractedNeed;
    }
    if (nextNeed && nextNeed !== conversation.detectedNeed) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { detectedNeed: nextNeed }
      });
    }
  }

  {
    let nextName: string | null = null;
    if (runtimeTurn.extractedName) {
      nextName = runtimeTurn.extractedName;
    }
    if (nextName && nextName !== conversation.detectedName) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { detectedName: nextName }
      });
    }
  }

  // Когда бот решает молчать (спам/офф-топик), reply пустой и в WhatsApp не
  // уходит (guard в apps/jobs). Не персистим пустой out-пузырь: он засоряет
  // ленту и ломает счётчик outboundLastHour/isFirstBotReply.
  if (runtimeTurn.reply && runtimeTurn.reply.trim().length > 0) {
    await prisma.waMessage.create({
      data: {
        conversationId: conversation.id,
        direction: "out",
        body: runtimeTurn.reply,
        parts: jsonInput(toAssistantParts(runtimeTurn.reply, runtimeTurn.actionButton))
      }
    });
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      customerName: input.senderName ?? conversation.customerName,
      lastMessageAt: new Date(),
      status: "open"
    }
  });

  const summary = runtimeTurn.summary || summarizeLead(profile, messageText);
  // Два номера для карточки: базовый WA-номер чата (реальный, не lid) и отдельно
  // «номер для связи», если клиент назвал другой. lid номером НЕ считаем.
  const { whatsappPhone, contactPhone } = resolveLeadPhones({
    chatId: input.chatId,
    senderPhone: input.senderPhone,
    extractedPhone: runtimeTurn.extractedPhone
  });
  const noName = !runtimeTurn.extractedName && !conversation.detectedName;
  if (
    runtimeTurn.shouldHandoff
    && (runtimeTurn.handoffType === "hot_lead" || runtimeTurn.handoffType === "requested")
    && noName
  ) {
    runtimeTurn.summary = `[имя не указано] ${summary}`.trim();
  }
  const leadId = await writeLeadIfNeeded(
    prisma,
    agent.id,
    conversation.id,
    runtimeTurn.summary || summary,
    messageText,
    runtimeTurn.shouldHandoff,
    options,
    runtimeTurn.handoffType ?? null,
    whatsappPhone,
    contactPhone
  );

  // Номер для связи, названный после закрытия, дописываем в открытый лид МОЛЧА —
  // отложенная карточка подхватит его (или останется в кабинете). Без второй карточки.
  await updateOpenLeadContactPhone(prisma, conversation.id, whatsappPhone, contactPhone);

  return {
    status: "ok",
    reply: runtimeTurn.reply,
    summary: runtimeTurn.summary || summary,
    leadId,
    conversationId: conversation.id,
    shouldHandoff: runtimeTurn.shouldHandoff,
    ...(runtimeTurn.actionButton ? { actionButton: runtimeTurn.actionButton } : {}),
    usage: trackResult.ok ? trackResult.usage : undefined,
    agentOwnerUserId: agent.userId ?? null,
    isFirstBotReply
  };
}
