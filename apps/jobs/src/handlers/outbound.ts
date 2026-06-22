import { getOutboundQueue, type WaOutboundJob } from "@jazu/queue";
import { env } from "../env.js";

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
  reply: string;
  inboundReceivedAtMs: number;
  isFirstBotReply: boolean;
  inboundJobId?: string;
  requestId?: string;
  waMessageId?: string;
}): Promise<void> {
  const targetReplyAtMs = computeTargetReplyAtMs(params.inboundReceivedAtMs, params.isFirstBotReply);
  const outbound: WaOutboundJob = {
    agentId: params.agentId,
    chatId: params.chatId,
    text: params.reply,
    humanize: true,
    inboundReceivedAtMs: params.inboundReceivedAtMs,
    targetReplyAtMs,
    isFirstBotReply: params.isFirstBotReply,
    ...(params.inboundJobId ? { inboundJobId: params.inboundJobId } : {}),
    ...(params.requestId ? { requestId: params.requestId } : {}),
    ...(params.waMessageId ? { waMessageId: params.waMessageId } : {})
  };
  await getOutboundQueue().add("wa-outbound", outbound);
}
