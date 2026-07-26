import { getFlushQueue, type WaFlushJob } from "@jazu/queue";
import { env } from "../env.js";
import { logger } from "../logger.js";

/** Стабильный jobId одного отложенного flush на чат (для debounce/changeDelay). */
function flushJobId(agentId: string, chatId: string): string {
  return `flush:${agentId}:${chatId}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Поставить/пересоздать отложенный flush для чата (гибрид «тишина + потолок»).
 *
 * Задержка = clamp(min(QUIET, batchStartedAt + MAX − now), 0, MAX):
 *  - на каждое новое сообщение таймер сбрасывается на QUIET (период тишины);
 *  - но не дальше MAX от первого неотвеченного сообщения (потолок).
 *
 * Логика по состоянию существующей задачи:
 *  - delayed/waiting → changeDelay (debounce-сброс таймера);
 *  - active (LLM крутится) → НЕ трогаем: добивку обеспечит self-reschedule в
 *    handleWaFlush после завершения (jobId сейчас занят, новую с ним не создать);
 *  - нет задачи → создаём новую (removeOnComplete освобождает jobId).
 */
export async function scheduleFlush(agentId: string, chatId: string, batchStartedAtMs: number): Promise<void> {
  const now = Date.now();
  const delay = clamp(
    Math.min(env.WA_BATCH_QUIET_MS, batchStartedAtMs + env.WA_BATCH_MAX_MS - now),
    0,
    env.WA_BATCH_MAX_MS
  );
  const queue = getFlushQueue();
  const jobId = flushJobId(agentId, chatId);

  const existing = await queue.getJob(jobId);
  if (existing) {
    let state = "unknown";
    try {
      state = await existing.getState();
    } catch {
      // ignore — обработаем как «не delayed»
    }
    if (state === "delayed" || state === "waiting") {
      try {
        await existing.changeDelay(delay);
        return;
      } catch (err) {
        // Состояние сменилось между getState и changeDelay (гонка) — упадём в add ниже.
        logger.debug(
          { agentId, chatId, err: err instanceof Error ? err.message : err },
          "flush changeDelay race, recreating"
        );
      }
    } else {
      // active/completed/failed — jobId занят, новую с тем же id не создать.
      return;
    }
  }

  await queue.add("wa-flush", { agentId, chatId } satisfies WaFlushJob, {
    jobId,
    delay,
    removeOnComplete: true
  });
}

/**
 * Снять отложенный flush: владелец ответил клиенту руками, боту отвечать нечем.
 * Курсор к этому моменту уже сдвинут (ingestOwnerOutbound), поэтому даже если
 * задача успела уйти в работу, она увидит пустой пакет — снятие лишь убирает
 * бессмысленный прогон и сужает окно гонки.
 */
export async function cancelPendingFlush(agentId: string, chatId: string): Promise<void> {
  const job = await getFlushQueue().getJob(flushJobId(agentId, chatId));
  if (!job) return;
  try {
    const state = await job.getState();
    if (state === "delayed" || state === "waiting") {
      await job.remove();
    }
  } catch {
    // Задача уже ушла в работу/удалена — идемпотентность обеспечит курсор.
  }
}

/**
 * Self-reschedule из активного flush: стабильный jobId сейчас занят (мы внутри
 * этой задачи), поэтому ставим разовую задачу с УНИКАЛЬНЫМ id и коротким окном.
 * Нужна, когда во время flush пришли новые входящие. Идемпотентность гарантирует
 * курсор: лишний flush увидит пустой пакет (nothing_to_flush).
 */
export async function rescheduleFlushSoon(agentId: string, chatId: string): Promise<void> {
  await getFlushQueue().add("wa-flush", { agentId, chatId } satisfies WaFlushJob, {
    jobId: `${flushJobId(agentId, chatId)}:r${Date.now()}`,
    delay: env.WA_BATCH_QUIET_MS,
    removeOnComplete: true
  });
}
