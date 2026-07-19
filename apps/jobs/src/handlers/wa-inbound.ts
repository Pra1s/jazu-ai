import { type Job, type WaInboundJob } from "@jazu/queue";
import { ingestWaInbound, cancelFollowup, scheduleFollowup } from "@jazu/wa-pipeline";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { enqueueReply } from "./outbound.js";
import { scheduleFlush } from "./flush-scheduler.js";
import { markBotActivatedOnce } from "./analytics.js";

/**
 * Обработчик одной задачи из очереди wa:inbound (фаза ingest).
 *
 * Алгоритм:
 *   1. ingestWaInbound — фильтры, дедуп, квота, распознавание голоса, СОХРАНЕНИЕ
 *      входящего. LLM НЕ зовём.
 *   2. Если ingested — планируем/пересоздаём отложенный flush (склейка нескольких
 *      входящих в один ответ; гибрид «тишина + потолок»). Сам ответ сформирует
 *      handleWaFlush, когда окно закроется.
 *   3. ok_immediate (голосовой fallback) — отвечаем сразу, минуя окно склейки.
 *   4. Терминальные статусы (deduplicated/quota/bot_paused/…) логируем и выходим —
 *      BullMQ не ретраит, т.к. мы не бросаем. Любое исключение бросается наверх.
 */
export async function handleWaInbound(job: Job<WaInboundJob>): Promise<void> {
  const started = Date.now();
  const { agentId, chatId, waMessageId, requestId } = job.data;
  const log = logger.child({ reqId: requestId ?? null, agentId, jobId: job.id });

  const result = await ingestWaInbound(job.data, {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    workerUrl: env.WA_WORKER_URL,
    internalToken: env.API_INTERNAL_TOKEN,
    leadNotifyDelayMs: env.LEAD_NOTIFY_DELAY_MS
  });

  const elapsedMs = Date.now() - started;

  if (result.status === "ingested") {
    // Клиент написал — отменяем запланированный дожим (серия начнётся заново после
    // следующего ответа бота во flush).
    await cancelFollowup(agentId, chatId);
    await scheduleFlush(agentId, chatId, result.batchStartedAtMs);
    log.info({ chatId, elapsedMs }, "wa:inbound ingested, flush scheduled");
    return;
  }

  if (result.status === "ok_immediate") {
    // Голосовой fallback: немедленный ответ без окна склейки.
    if (result.reply && result.reply.trim().length > 0) {
      const inboundReceivedAtMs =
        job.data.messageTimestamp !== undefined ? job.data.messageTimestamp * 1000 : Date.now();
      await enqueueReply({
        agentId,
        chatId,
        reply: result.reply,
        inboundReceivedAtMs,
        isFirstBotReply: result.isFirstBotReply,
        ...(job.id ? { inboundJobId: String(job.id) } : {}),
        ...(requestId ? { requestId } : {}),
        ...(waMessageId ? { waMessageId } : {})
      });
      if (result.isFirstBotReply && result.agentOwnerUserId) {
        await markBotActivatedOnce(result.agentOwnerUserId, agentId, log);
      }
      // Немедленный ответ = тоже ход бота: перезапускаем серию дожима с нуля.
      await cancelFollowup(agentId, chatId);
      await scheduleFollowup(agentId, chatId, 0);
    }
    log.info({ chatId, elapsedMs }, "wa:inbound immediate reply (voice fallback)");
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

  if (result.status === "bot_paused") {
    log.info({ chatId }, "wa:inbound bot paused by owner — drop");
    return;
  }

  if (result.status === "pre_connection_message") {
    log.info({ chatId }, "wa:inbound pre-connection message — drop");
    return;
  }
}
