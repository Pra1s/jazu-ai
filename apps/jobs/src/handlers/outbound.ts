import { getOutboundQueue, OUTBOUND_JOB_OPTIONS, type WaOutboundJob } from "@jazu/queue";
import { env } from "../env.js";
import { logger } from "../logger.js";

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Целевое время ответа («человеческая» задержка). Считается от времени ВХОДЯЩЕГО
 * (inboundReceivedAtMs), а не от «сейчас». В пакетном режиме inboundReceivedAtMs —
 * это момент первого сообщения пакета, поэтому к моменту flush (после окна склейки)
 * задержка обычно уже истекла и outbound уходит почти сразу (только typing).
 */
export function computeTargetReplyAtMs(inboundReceivedAtMs: number, isFirstBotReply: boolean): number {
  const [minMs, maxMs] = isFirstBotReply
    ? [env.WA_REPLY_DELAY_FIRST_MIN_MS, env.WA_REPLY_DELAY_FIRST_MAX_MS]
    : [env.WA_REPLY_DELAY_MIN_MS, env.WA_REPLY_DELAY_MAX_MS];
  return inboundReceivedAtMs + randomInt(minMs, maxMs);
}

/**
 * Положить ответ бота в wa:outbound — оттуда его заберёт wa-worker и отправит
 * через Baileys (с humanize-таймингом). Общая точка для немедленного ответа
 * (голосовой fallback) и пакетного flush.
 */
export async function enqueueReply(params: {
  agentId: string;
  chatId: string;
  /** Один ответ (fallback). Если задан replies — используется он. */
  reply?: string;
  /** Мультисообщения: пузыри для последовательной отправки. */
  replies?: string[];
  inboundReceivedAtMs: number;
  isFirstBotReply: boolean;
  inboundJobId?: string;
  requestId?: string;
  waMessageId?: string;
}): Promise<void> {
  const parts = (params.replies && params.replies.length > 0
    ? params.replies
    : [params.reply ?? ""]
  ).filter((t) => t && t.trim().length > 0);
  if (parts.length === 0) return;
  const targetReplyAtMs = computeTargetReplyAtMs(params.inboundReceivedAtMs, params.isFirstBotReply);
  const outbound: WaOutboundJob = {
    agentId: params.agentId,
    chatId: params.chatId,
    text: parts.join("\n"),
    ...(parts.length > 1 ? { texts: parts } : {}),
    humanize: true,
    inboundReceivedAtMs: params.inboundReceivedAtMs,
    targetReplyAtMs,
    isFirstBotReply: params.isFirstBotReply,
    ...(params.inboundJobId ? { inboundJobId: params.inboundJobId } : {}),
    ...(params.requestId ? { requestId: params.requestId } : {}),
    ...(params.waMessageId ? { waMessageId: params.waMessageId } : {})
  };
  // Логируем размер ответа В ПУЗЫРЯХ: без этого «бот прислал одно сообщение»
  // не отличить от «модель и сформулировала один пузырь» — а лечатся эти
  // ситуации совершенно по-разному (доставка vs промпт).
  logger.info(
    {
      agentId: params.agentId,
      chatId: params.chatId,
      bubbles: parts.length,
      ...(params.requestId ? { reqId: params.requestId } : {})
    },
    "wa:outbound enqueued"
  );
  await getOutboundQueue().add("wa-outbound", outbound, OUTBOUND_JOB_OPTIONS);
}
