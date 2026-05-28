import { getOutboundQueue, type Job, type WaInboundJob, type WaOutboundJob } from "@jazu/queue";
import { processWaInbound } from "@jazu/wa-pipeline";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Обработчик одной задачи из очереди wa:inbound.
 *
 * Алгоритм:
 *   1. Прогоняем сообщение через общий pipeline (dedupe → квота → LLM →
 *      persist) — это та же функция, что вызывается из legacy HTTP-эндпойнта.
 *   2. Если pipeline вернул reply — кладём задачу в wa:outbound, откуда
 *      её заберёт wa-worker и отправит через Baileys.
 *   3. Все нерекаверабельные состояния (agent_not_found, quota_exhausted,
 *      worker_session_mismatch) логируем и возвращаем — BullMQ не будет
 *      ретраить их, потому что мы их не бросаем.
 *   4. Любая исключительная ошибка (LLM 500, DB connection lost, etc.)
 *      бросается наверх — BullMQ ретрайнет с exponential backoff.
 */
export async function handleWaInbound(job: Job<WaInboundJob>): Promise<void> {
  const started = Date.now();
  const { agentId, chatId, waMessageId, requestId } = job.data;
  const log = logger.child({ reqId: requestId ?? null, agentId, jobId: job.id });

  const result = await processWaInbound(job.data, {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN
  });

  const elapsedMs = Date.now() - started;

  if (result.status === "ok") {
    if (result.reply && result.reply.trim().length > 0) {
      const outbound: WaOutboundJob = {
        agentId,
        chatId,
        text: result.reply,
        ...(job.id ? { inboundJobId: String(job.id) } : {}),
        ...(requestId ? { requestId } : {})
      };
      await getOutboundQueue().add("wa-outbound", outbound);
    }
    log.info(
      { chatId, elapsedMs, leadId: result.leadId, handoff: result.shouldHandoff },
      "wa:inbound processed"
    );
    return;
  }

  if (result.status === "quota_exhausted") {
    log.warn({ chatId, elapsedMs }, "wa:inbound quota exhausted — bot silent");
    return;
  }

  if (result.status === "deduplicated") {
    log.info({ chatId, waMessageId }, "wa:inbound deduplicated");
    return;
  }

  if (result.status === "worker_session_mismatch") {
    log.warn({ chatId }, "wa:inbound worker session mismatch — agent was re-paired");
    return;
  }

  if (result.status === "agent_not_found") {
    log.error({}, "wa:inbound agent not found — drop");
    return;
  }

  if (result.status === "bot_loop_protected") {
    log.warn(
      { chatId, outboundLastHour: result.outboundLastHour },
      "wa:inbound bot-loop protection triggered — bot silent"
    );
    return;
  }

  if (result.status === "bot_paused") {
    log.info({ chatId }, "wa:inbound bot paused by owner — drop");
    return;
  }

  if (result.status === "pre_connection_message") {
    log.info({ chatId }, "wa:inbound pre-connection message — drop");
    return;
  }
}
