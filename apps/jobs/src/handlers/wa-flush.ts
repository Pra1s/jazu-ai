import { type Job, type WaFlushJob } from "@jazu/queue";
import { flushWaConversation, scheduleFollowup } from "@jazu/wa-pipeline";
import { capturePostHog } from "@jazu/observability";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { enqueueReply } from "./outbound.js";
import { rescheduleFlushSoon } from "./flush-scheduler.js";
import { markBotActivatedOnce } from "./analytics.js";

/**
 * Обработчик задачи из очереди wa:flush (фаза flush — склейка входящих).
 *
 * Окно склейки закрылось → собираем ВСЕ неотвеченные входящие чата, зовём LLM
 * ОДИН раз, и если есть ответ — кладём его в wa:outbound. Курсор отвеченного
 * двигается внутри flushWaConversation (атомарно с записью ответа), поэтому
 * повторный/гонящий flush идемпотентен (nothing_to_flush).
 *
 * Self-reschedule: если за время flush (пока LLM крутился) пришли новые входящие
 * (hasMoreUnanswered), ставим ещё один flush — это закрывает гонку «сообщение
 * пришло, пока задача была active» (тогда scheduleFlush из ingest её не пересоздал).
 */
export async function handleWaFlush(job: Job<WaFlushJob>): Promise<void> {
  const started = Date.now();
  const { agentId, chatId, requestId } = job.data;
  const log = logger.child({ reqId: requestId ?? null, agentId, jobId: job.id });

  const result = await flushWaConversation(agentId, chatId, {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    workerUrl: env.WA_WORKER_URL,
    internalToken: env.API_INTERNAL_TOKEN,
    leadNotifyDelayMs: env.LEAD_NOTIFY_DELAY_MS
  });

  const elapsedMs = Date.now() - started;

  if (result.status === "nothing_to_flush") {
    log.debug({ chatId }, "wa:flush nothing to flush");
    return;
  }

  if (result.status === "agent_not_found") {
    log.error({ chatId }, "wa:flush agent not found — drop");
    return;
  }

  if (result.status === "bot_paused") {
    log.info({ chatId }, "wa:flush bot paused by owner — batch dropped");
    if (result.hasMoreUnanswered) await rescheduleFlushSoon(agentId, chatId);
    return;
  }

  if (result.status === "bot_loop_protected") {
    log.warn(
      { chatId, outboundLastHour: result.outboundLastHour },
      "wa:flush bot-loop protection triggered — bot silent"
    );
    if (result.hasMoreUnanswered) await rescheduleFlushSoon(agentId, chatId);
    return;
  }

  // result.status === "flushed"
  if (result.reply && result.reply.trim().length > 0) {
    await enqueueReply({
      agentId,
      chatId,
      replies: result.replyParts,
      // Тайминг считаем от первого сообщения пакета — задержка обычно уже истекла
      // за время окна склейки, поэтому ответ уходит почти сразу (только typing).
      inboundReceivedAtMs: result.batchFirstMessageMs,
      isFirstBotReply: result.isFirstBotReply,
      ...(job.id ? { inboundJobId: String(job.id) } : {}),
      ...(requestId ? { requestId } : {})
    });

    // Активация владельца — только на первом живом ответе.
    if (result.isFirstBotReply && result.agentOwnerUserId) {
      await markBotActivatedOnce(result.agentOwnerUserId, agentId, log);
    }

    // Дожим: после ответа бота планируем серию с нуля (attempt 0). Отменится при
    // следующем входящем клиента. Best-effort — не влияет на основной поток.
    await scheduleFollowup(agentId, chatId, 0, { lastClientAtMs: result.batchFirstMessageMs });
  }

  // Новый лид — шлём событие РОВНО при создании лида в этом flush (не на каждом
  // повторном handoff), distinctId = владелец агента.
  if (result.leadCreated && result.shouldHandoff && result.leadId && result.agentOwnerUserId) {
    capturePostHog({
      distinctId: result.agentOwnerUserId,
      event: "client_lead_created",
      properties: { agentId, leadId: result.leadId }
    });
  }

  log.info(
    { chatId, elapsedMs, leadId: result.leadId, handoff: result.shouldHandoff, more: result.hasMoreUnanswered },
    "wa:flush processed"
  );

  // Сообщения, пришедшие за время flush, — добиваем отдельным окном.
  if (result.hasMoreUnanswered) await rescheduleFlushSoon(agentId, chatId);
}
