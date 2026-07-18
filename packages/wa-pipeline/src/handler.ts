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
import { retrieveStyleExamples } from "./style-rag.js";

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

/**
 * Результат фазы ingest (сохранение входящего без LLM).
 *  - `ingested` — сообщение сохранено, нужно запланировать flush;
 *  - `ok_immediate` — дан немедленный ответ без LLM (голосовой fallback, когда
 *    распознать не удалось и это единственное неотвеченное сообщение чата);
 *  - остальные статусы терминальны (как в WaInboundResult): обработку прекращаем.
 */
export type IngestResult =
  | {
      status: "ingested";
      agentId: string;
      conversationId: string;
      /** createdAt(ms) самого раннего неотвеченного входящего — старт окна склейки. */
      batchStartedAtMs: number;
      usage: UsageView | undefined;
    }
  | {
      status: "ok_immediate";
      reply: string;
      conversationId: string;
      agentOwnerUserId: string | null;
      isFirstBotReply: boolean;
      usage: UsageView | undefined;
    }
  | { status: "deduplicated"; conversationId: string }
  | { status: "agent_not_found" }
  | { status: "worker_session_mismatch" }
  | { status: "quota_exhausted"; usage: UsageView | undefined }
  | { status: "bot_paused" }
  | { status: "pre_connection_message" };

/** Результат фазы flush (склейка неотвеченных входящих → один LLM-ответ). */
export type FlushResult =
  | {
      status: "flushed";
      reply: string;
      summary: string;
      conversationId: string;
      leadId: string | null;
      /** Лид СОЗДАН именно в этом flush (для разовой аналитики client_lead_created). */
      leadCreated: boolean;
      shouldHandoff: boolean;
      actionButton?: ActionButton | undefined;
      agentOwnerUserId: string | null;
      isFirstBotReply: boolean;
      /** createdAt(ms) первого сообщения пакета — для humanize-тайминга outbound. */
      batchFirstMessageMs: number;
      /** Есть ли входящие новее нового курсора (пришли во время flush) — для self-reschedule. */
      hasMoreUnanswered: boolean;
    }
  | { status: "nothing_to_flush" }
  | { status: "agent_not_found" }
  | { status: "bot_paused"; hasMoreUnanswered: boolean }
  | {
      status: "bot_loop_protected";
      conversationId: string;
      outboundLastHour: number;
      hasMoreUnanswered: boolean;
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

async function getOrCreateConversation(
  prisma: PrismaClient,
  agentId: string,
  chatId: string,
  customerName?: string,
  customerPhone?: string
) {
  const updateData: {
    customerName?: string | null;
    customerPhone?: string | null;
    lastMessageAt: Date;
    status: "open";
  } = {
    lastMessageAt: new Date(),
    status: "open"
  };
  if (customerName !== undefined) {
    updateData.customerName = customerName;
  }
  // Телефон пишем только при первом появлении (не затираем уже сохранённый при
  // каждом сообщении — он стабилен на чат).
  if (customerPhone !== undefined) {
    updateData.customerPhone = customerPhone;
  }
  return prisma.conversation.upsert({
    where: { agentId_waChatId: { agentId, waChatId: chatId } },
    update: updateData,
    create: {
      agentId,
      waChatId: chatId,
      customerName: customerName ?? null,
      customerPhone: customerPhone ?? null,
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
): Promise<{ leadId: string | null; created: boolean }> {
  if (!shouldCreate) return { leadId: null, created: false };
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
    return { leadId: existing.id, created: false };
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

  return { leadId: lead.id, created: true };
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

type BatchMessage = { id: string; createdAt: Date; body: string; direction: "in" | "out" };

/**
 * Неотвеченный «пакет» входящих для склейки: все `direction:in` строго ПОСЛЕ
 * курсора `lastAnsweredWaMessageId` по детерминированному порядку (createdAt, id).
 *
 * Порядок (createdAt, id) устойчив к коллизиям мс: при равных createdAt тай-брейк
 * по id (cuid уникален). Курсор храним как id; если строка-курсор удалена
 * retention'ом — фолбэк на «входящие после последнего исходящего», что для
 * сброшенного ретеншном диалога даёт корректный набор реально неотвеченных.
 */
async function selectUnansweredBatch(
  prisma: PrismaClient,
  conversationId: string,
  cursorId: string | null
): Promise<BatchMessage[]> {
  const afterWhere = (anchor: { createdAt: Date; id: string }): Prisma.WaMessageWhereInput => ({
    conversationId,
    direction: "in",
    OR: [
      { createdAt: { gt: anchor.createdAt } },
      { AND: [{ createdAt: anchor.createdAt }, { id: { gt: anchor.id } }] }
    ]
  });

  const cursorMsg = cursorId
    ? await prisma.waMessage.findUnique({ where: { id: cursorId }, select: { createdAt: true, id: true } })
    : null;

  let where: Prisma.WaMessageWhereInput;
  if (cursorMsg) {
    where = afterWhere(cursorMsg);
  } else {
    const lastOut = await prisma.waMessage.findFirst({
      where: { conversationId, direction: "out" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true, id: true }
    });
    where = lastOut ? { ...afterWhere(lastOut), direction: "in" } : { conversationId, direction: "in" };
  }

  return prisma.waMessage.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, body: true, direction: true }
  });
}

/** Есть ли входящие строго новее курсора (пришли во время flush). */
async function countUnansweredAfter(
  prisma: PrismaClient,
  conversationId: string,
  anchor: { createdAt: Date; id: string }
): Promise<number> {
  return prisma.waMessage.count({
    where: {
      conversationId,
      direction: "in",
      OR: [
        { createdAt: { gt: anchor.createdAt } },
        { AND: [{ createdAt: anchor.createdAt }, { id: { gt: anchor.id } }] }
      ]
    }
  });
}

/**
 * Фаза 1 — ingest. Всё, что ДО LLM: фильтры, дедуп, квота, распознавание голоса,
 * сохранение входящего. НЕ зовёт LLM, НЕ пишет ответ/лид. Возвращает `ingested`
 * (нужно запланировать flush) или терминальный статус. Голосовой fallback —
 * единственное исключение: если распознать не удалось и это единственное
 * неотвеченное сообщение, отвечаем сразу (`ok_immediate`) и двигаем курсор.
 */
export async function ingestWaInbound(
  input: WaInboundInput,
  options: WaInboundOptions = {}
): Promise<IngestResult> {
  const prisma = options.prisma ?? defaultPrisma;

  if (input.workerSessionId) {
    const conn = await prisma.waConnection.findUnique({ where: { agentId: input.agentId } });
    if (!conn || !conn.workerSessionId || conn.workerSessionId !== input.workerSessionId) {
      return { status: "worker_session_mismatch" };
    }
  }

  const agent = await prisma.agent.findUnique({
    where: { id: input.agentId },
    include: { user: true }
  });
  if (!agent) return { status: "agent_not_found" };

  // Глобальный «выключатель» бота: владелец агента может поставить бот на паузу.
  // НЕ сохраняем inbound, НЕ списываем квоту — будто бота вообще нет.
  if (!agent.botEnabled) {
    return { status: "bot_paused" };
  }

  // Фильтр «бот отвечает только на сообщения после подключения» (history-sync
  // flood + вторжение в чаты вне бота). Если botRespondsSince=NULL — выключен.
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

  // Чат существовал в WhatsApp ДО подключения (снимок WaPreConnectionChat) — не лезем.
  const preConnectionChat = await prisma.waPreConnectionChat.findUnique({
    where: { agentId_waChatId: { agentId: agent.id, waChatId: input.chatId } },
    select: { id: true }
  });
  if (preConnectionChat) {
    return { status: "pre_connection_message" };
  }

  const trackResult = await trackConversationUsage(prisma, {
    agentOwnerUserId: agent.userId ?? null,
    agentId: agent.id,
    chatId: input.chatId
  });
  if (!trackResult.ok && trackResult.reason === "exhausted") {
    return { status: "quota_exhausted", usage: trackResult.usage };
  }
  const usage = trackResult.ok ? trackResult.usage : undefined;

  const conversation = await getOrCreateConversation(
    prisma,
    agent.id,
    input.chatId,
    input.senderName,
    input.senderPhone
  );

  if (input.waMessageId) {
    const dup = await prisma.waMessage.findFirst({
      where: { conversationId: conversation.id, waMsgId: input.waMessageId, direction: "in" }
    });
    if (dup) {
      return { status: "deduplicated", conversationId: conversation.id };
    }
  }

  // Голосовое: текста нет, но есть аудио → распознаём ПОСЛЕ dedupe (не платим за дубли).
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

  // Распознать не удалось. Сохраняем как голосовое. Если в окне уже есть другие
  // неотвеченные входящие — отвечать сразу не нужно: пусть flush обработает весь
  // пакет (голосовое войдёт как контекст). Если это единственное неотвеченное —
  // мягкий текстовый фолбэк сразу + двигаем курсор за него.
  if (isVoiceMessage && !messageText) {
    const voiceMsg = await prisma.waMessage.create({
      data: {
        conversationId: conversation.id,
        direction: "in",
        body: "[голосовое сообщение]",
        waMsgId: input.waMessageId ?? null,
        parts: jsonInput([{ type: "text", text: "[голосовое сообщение]" }])
      }
    });
    const batch = await selectUnansweredBatch(prisma, conversation.id, conversation.lastAnsweredWaMessageId);
    const onlyThisVoice = batch.length === 1 && batch[0]?.id === voiceMsg.id;
    if (!onlyThisVoice) {
      const batchStartedAtMs = (batch[0]?.createdAt ?? voiceMsg.createdAt).getTime();
      return { status: "ingested", agentId: agent.id, conversationId: conversation.id, batchStartedAtMs, usage };
    }
    const priorOutbound = await prisma.waMessage.count({
      where: { conversationId: conversation.id, direction: "out" }
    });
    const fallbackReply =
      "Извините, не получилось распознать голосовое. Напишите, пожалуйста, текстом.";
    await prisma.$transaction([
      prisma.waMessage.create({
        data: {
          conversationId: conversation.id,
          direction: "out",
          body: fallbackReply,
          parts: jsonInput(toAssistantParts(fallbackReply, undefined))
        }
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date(), status: "open", lastAnsweredWaMessageId: voiceMsg.id }
      })
    ]);
    return {
      status: "ok_immediate",
      reply: fallbackReply,
      conversationId: conversation.id,
      agentOwnerUserId: agent.userId ?? null,
      isFirstBotReply: priorOutbound === 0,
      usage
    };
  }

  const inboundMsg = await prisma.waMessage.create({
    data: {
      conversationId: conversation.id,
      direction: "in",
      body: messageText,
      waMsgId: input.waMessageId ?? null,
      parts: jsonInput([{ type: "text", text: messageText }])
    }
  });

  // Старт окна склейки = createdAt самого раннего неотвеченного входящего (может
  // быть раньше только что сохранённого — клиент уже писал в этом окне).
  const batch = await selectUnansweredBatch(prisma, conversation.id, conversation.lastAnsweredWaMessageId);
  const batchStartedAtMs = (batch[0]?.createdAt ?? inboundMsg.createdAt).getTime();

  return { status: "ingested", agentId: agent.id, conversationId: conversation.id, batchStartedAtMs, usage };
}

/**
 * Фаза 2 — flush. Собирает ВСЕ неотвеченные входящие чата в один ход клиента,
 * зовёт LLM один раз, пишет ответ и (после коммита) лид. Курсор
 * `lastAnsweredWaMessageId` двигаем ВСЕГДА, когда пакет обработан (ответ/молчание/
 * loop-protection/пауза) — иначе хвост неотвеченных растёт бесконечно.
 *
 * Идемпотентность: запись исходящего + сдвиг курсора + апдейт conversation — в
 * одной транзакции; enqueue в wa:outbound и аналитику делает уже consumer ПОСЛЕ
 * коммита. Повторный flush после коммита увидит пустой пакет → nothing_to_flush.
 */
export async function flushWaConversation(
  agentId: string,
  chatId: string,
  options: WaInboundOptions = {}
): Promise<FlushResult> {
  const prisma = options.prisma ?? defaultPrisma;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { businessProfile: true, user: true }
  });
  if (!agent) return { status: "agent_not_found" };

  const conversation = await prisma.conversation.findUnique({
    where: { agentId_waChatId: { agentId, waChatId: chatId } }
  });
  if (!conversation) return { status: "nothing_to_flush" };

  const batch = await selectUnansweredBatch(prisma, conversation.id, conversation.lastAnsweredWaMessageId);
  if (batch.length === 0) return { status: "nothing_to_flush" };

  const firstBatch = batch[0]!;
  const lastBatch = batch[batch.length - 1]!;

  // Владелец мог поставить бота на паузу за время окна — не отвечаем, но двигаем
  // курсор (пакет считаем обработанным: «как будто бота нет»).
  if (!agent.botEnabled) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastAnsweredWaMessageId: lastBatch.id }
    });
    return { status: "bot_paused", hasMoreUnanswered: (await countUnansweredAfter(prisma, conversation.id, lastBatch)) > 0 };
  }

  // Bot-loop protection: если бот за час уже отбомбил > лимита — молчим, но
  // двигаем курсор (входящие уже сохранены на ingest).
  const botLoopLimit = options.botLoopMaxRepliesPerHour ?? DEFAULT_BOT_LOOP_LIMIT;
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const outboundLastHour = await prisma.waMessage.count({
    where: { conversationId: conversation.id, direction: "out", createdAt: { gte: hourAgo } }
  });
  if (outboundLastHour >= botLoopLimit) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastAnsweredWaMessageId: lastBatch.id }
    });
    return {
      status: "bot_loop_protected",
      conversationId: conversation.id,
      outboundLastHour,
      hasMoreUnanswered: (await countUnansweredAfter(prisma, conversation.id, lastBatch)) > 0
    };
  }

  const profile = agent.businessProfile
    ? businessProfileSchema.parse(agent.businessProfile.data)
    : createInitialProfile();

  const activePromptVersion = await prisma.promptVersion.findFirst({
    where: { agentId: agent.id },
    orderBy: { createdAt: "desc" }
  });
  const systemOverride = activePromptVersion?.content || agent.currentPrompt || null;

  const priorOutboundCount = await prisma.waMessage.count({
    where: { conversationId: conversation.id, direction: "out" }
  });
  const isFirstBotReply = priorOutboundCount === 0;

  // Склейка пакета в ОДИН ход клиента (несколько реплик через перевод строки).
  const combinedMessage = batch
    .map((m) => m.body)
    .join("\n")
    .trim();

  // История строго ДО пакета (последние 20 сообщений по (createdAt, id)).
  const priorHistory = await prisma.waMessage.findMany({
    where: {
      conversationId: conversation.id,
      OR: [
        { createdAt: { lt: firstBatch.createdAt } },
        { AND: [{ createdAt: firstBatch.createdAt }, { id: { lt: firstBatch.id } }] }
      ]
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20
  });
  priorHistory.reverse();

  const telemetry = buildLlmTelemetry({
    prisma,
    route: "wa-inbound",
    userId: agent.userId ?? null,
    agentId: agent.id
  });

  // РОЛЬ/КАРКАС из authoritative-источника (Agent), а не из профиля.
  const runtimeProfile = {
    ...profile,
    carcass: (agent.carcass ?? null) as Carcass | null,
    botModel: (agent.botModel ?? null) as
      | "admin" | "consultant" | "support" | "qualifier" | "salesman" | null
  } as typeof profile;

  // RAG «бот в стиле владельца»: если стиль собран — подтягиваем похожие обмены
  // владельца под текущий вопрос клиента (top-5). Латентность ~100 мс незаметна на
  // фоне humanize-задержки. Любая ошибка внутри → пустой массив (деградация на статику).
  const retrievedExamples = runtimeProfile.styleGuide
    ? await retrieveStyleExamples(prisma, agent.id, combinedMessage, 5)
    : [];

  const runtimeTurn = await buildRuntimeTurn(
    runtimeProfile,
    combinedMessage,
    priorHistory.map((item) => ({
      role: item.direction === "out" ? "assistant" : "user",
      content: item.body
    })),
    {
      systemOverride,
      detectedNeed: conversation.detectedNeed,
      detectedName: conversation.detectedName,
      telemetry,
      retrievedExamples
    }
  );

  // Буфер потребности: needChanged-перезапись проверяем ПЕРВОЙ.
  let nextNeed: string | null = null;
  if (runtimeTurn.needChanged && runtimeTurn.extractedNeed) {
    nextNeed = runtimeTurn.extractedNeed;
  } else if (!conversation.detectedNeed && runtimeTurn.extractedNeed) {
    nextNeed = runtimeTurn.extractedNeed;
  }
  const needToWrite = nextNeed && nextNeed !== conversation.detectedNeed ? nextNeed : null;
  const nameToWrite =
    runtimeTurn.extractedName && runtimeTurn.extractedName !== conversation.detectedName
      ? runtimeTurn.extractedName
      : null;

  // Пустой reply — осознанное молчание (спам/офф-топик); пустой пузырь не пишем.
  const hasReply = Boolean(runtimeTurn.reply && runtimeTurn.reply.trim().length > 0);

  // Транзакция: исходящее (если есть) + сдвиг курсора + апдейт conversation.
  // Курсор и outbound коммитим атомарно → ретрай после коммита = nothing_to_flush.
  await prisma.$transaction([
    ...(hasReply
      ? [
          prisma.waMessage.create({
            data: {
              conversationId: conversation.id,
              direction: "out",
              body: runtimeTurn.reply,
              parts: jsonInput(toAssistantParts(runtimeTurn.reply, runtimeTurn.actionButton))
            }
          })
        ]
      : []),
    prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        status: "open",
        lastAnsweredWaMessageId: lastBatch.id,
        ...(needToWrite ? { detectedNeed: needToWrite } : {}),
        ...(nameToWrite ? { detectedName: nameToWrite } : {})
      }
    })
  ]);

  const summary = runtimeTurn.summary || summarizeLead(profile, combinedMessage);
  // Два номера для карточки: базовый WA-номер чата (реальный, не lid) и отдельно
  // «номер для связи». senderPhone берём из conversation (сохранён на ingest).
  const { whatsappPhone, contactPhone } = resolveLeadPhones({
    chatId,
    senderPhone: conversation.customerPhone,
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
  const lead = await writeLeadIfNeeded(
    prisma,
    agent.id,
    conversation.id,
    runtimeTurn.summary || summary,
    combinedMessage,
    runtimeTurn.shouldHandoff,
    options,
    runtimeTurn.handoffType ?? null,
    whatsappPhone,
    contactPhone
  );

  // Номер для связи, названный после закрытия, дописываем в открытый лид МОЛЧА.
  await updateOpenLeadContactPhone(prisma, conversation.id, whatsappPhone, contactPhone);

  return {
    status: "flushed",
    reply: runtimeTurn.reply,
    summary: runtimeTurn.summary || summary,
    conversationId: conversation.id,
    leadId: lead.leadId,
    leadCreated: lead.created,
    shouldHandoff: runtimeTurn.shouldHandoff,
    ...(runtimeTurn.actionButton ? { actionButton: runtimeTurn.actionButton } : {}),
    agentOwnerUserId: agent.userId ?? null,
    isFirstBotReply,
    batchFirstMessageMs: firstBatch.createdAt.getTime(),
    hasMoreUnanswered: (await countUnansweredAfter(prisma, conversation.id, lastBatch)) > 0
  };
}

/**
 * Legacy/dev обёртка (HTTP `/whatsapp/inbound`): ingest → немедленный flush, без
 * окна склейки. Сохраняет прежний контракт WaInboundResult для роута и dev-пути
 * без Redis. Production-путь (apps/jobs) зовёт ingest и flush раздельно.
 */
export async function processWaInbound(
  input: WaInboundInput,
  options: WaInboundOptions = {}
): Promise<WaInboundResult> {
  const ingest = await ingestWaInbound(input, options);

  if (ingest.status === "ok_immediate") {
    return {
      status: "ok",
      reply: ingest.reply,
      summary: "",
      leadId: null,
      conversationId: ingest.conversationId,
      shouldHandoff: false,
      usage: ingest.usage,
      agentOwnerUserId: ingest.agentOwnerUserId,
      isFirstBotReply: ingest.isFirstBotReply
    };
  }
  if (ingest.status !== "ingested") {
    // deduplicated / quota_exhausted / agent_not_found / worker_session_mismatch /
    // bot_paused / pre_connection_message — формы совпадают с WaInboundResult.
    return ingest;
  }

  const flush = await flushWaConversation(ingest.agentId, input.chatId, options);
  if (flush.status === "flushed") {
    return {
      status: "ok",
      reply: flush.reply,
      summary: flush.summary,
      leadId: flush.leadId,
      conversationId: flush.conversationId,
      shouldHandoff: flush.shouldHandoff,
      ...(flush.actionButton ? { actionButton: flush.actionButton } : {}),
      usage: ingest.usage,
      agentOwnerUserId: flush.agentOwnerUserId,
      isFirstBotReply: flush.isFirstBotReply
    };
  }
  if (flush.status === "bot_loop_protected") {
    return {
      status: "bot_loop_protected",
      conversationId: flush.conversationId,
      outboundLastHour: flush.outboundLastHour
    };
  }
  if (flush.status === "bot_paused") {
    return { status: "bot_paused" };
  }
  if (flush.status === "agent_not_found") {
    return { status: "agent_not_found" };
  }
  // nothing_to_flush в legacy-пути недостижим (только что сохранили входящее),
  // но на всякий случай отдаём пустой ok без побочных эффектов.
  return {
    status: "ok",
    reply: "",
    summary: "",
    leadId: null,
    conversationId: ingest.conversationId,
    shouldHandoff: false,
    usage: ingest.usage,
    agentOwnerUserId: null,
    isFirstBotReply: false
  };
}
