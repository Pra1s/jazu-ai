import {
  buildRuntimeTurn,
  createInitialProfile,
  summarizeLead
} from "@jazu/ai";
import { prisma as defaultPrisma, type Prisma } from "@jazu/db";
import {
  actionButtonSchema,
  businessProfileSchema,
  type ActionButton
} from "@jazu/shared";
import { sendTelegramLead } from "./notifications.js";
import { trackConversationUsage, type UsageView } from "./billing.js";
import { buildLlmTelemetry } from "./llm-telemetry.js";

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
  message: string;
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
   * Bot-loop protection: если за последний час бот уже ответил этому chatId
   * больше N раз — пропускаем без LLM-вызова. Защищает от бесконечного
   * «бот → бот» цикла и от спам-ботов на стороне клиента.
   * По умолчанию 30 (норма ~5-10 ответов в час даже у активного диалога).
   */
  botLoopMaxRepliesPerHour?: number;
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

async function writeLeadIfNeeded(
  prisma: PrismaClient,
  agentId: string,
  conversationId: string,
  summary: string,
  message: string,
  shouldCreate: boolean,
  telegramBotToken: string | undefined
): Promise<string | null> {
  if (!shouldCreate) return null;
  const existing = await prisma.lead.findFirst({
    where: { conversationId, status: "new" }
  });
  if (existing) return existing.id;

  const lead = await prisma.lead.create({
    data: {
      conversationId,
      summary,
      niche: null,
      fields: {
        sourceMessage: message,
        createdAt: new Date().toISOString()
      },
      status: "new"
    }
  });

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { user: true }
  });

  if (agent?.user?.telegramChatId) {
    void sendTelegramLead(
      telegramBotToken,
      agent.user.telegramChatId,
      [`<b>Новый лид</b>`, summary, `Agent: ${agent.name}`].join("\n")
    );
  }

  return lead.id;
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
      body: input.message,
      waMsgId: input.waMessageId ?? null,
      parts: jsonInput([{ type: "text", text: input.message }])
    }
  });

  if (outboundLastHour >= botLoopLimit) {
    return {
      status: "bot_loop_protected",
      conversationId: conversation.id,
      outboundLastHour
    };
  }

  const history = await prisma.waMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    take: 20
  });

  const telemetry = buildLlmTelemetry({
    prisma,
    route: "wa-inbound",
    userId: agent.userId ?? null,
    agentId: agent.id
  });

  const runtimeTurn = await buildRuntimeTurn(
    profile,
    input.message,
    history
      .slice(0, -1)
      .map((item) => ({
        role: item.direction === "out" ? "assistant" : "user",
        content: item.body
      })),
    { systemOverride, telemetry }
  );

  await prisma.waMessage.create({
    data: {
      conversationId: conversation.id,
      direction: "out",
      body: runtimeTurn.reply,
      parts: jsonInput(toAssistantParts(runtimeTurn.reply, runtimeTurn.actionButton))
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

  const summary = runtimeTurn.summary || summarizeLead(profile, input.message);
  const leadId = await writeLeadIfNeeded(
    prisma,
    agent.id,
    conversation.id,
    summary,
    input.message,
    runtimeTurn.shouldHandoff,
    options.telegramBotToken
  );

  return {
    status: "ok",
    reply: runtimeTurn.reply,
    summary,
    leadId,
    conversationId: conversation.id,
    shouldHandoff: runtimeTurn.shouldHandoff,
    ...(runtimeTurn.actionButton ? { actionButton: runtimeTurn.actionButton } : {}),
    usage: trackResult.ok ? trackResult.usage : undefined
  };
}
