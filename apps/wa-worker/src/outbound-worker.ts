import {
  QUEUE_WA_OUTBOUND,
  startWorker,
  type Job,
  type StartedWorker,
  type WaOutboundJob
} from "@jazu/queue";
import { env } from "./env.js";
import type { ConnectionManager } from "./manager.js";

/**
 * Consumer для wa:outbound. Запускается ВНУТРИ wa-worker процесса, потому что
 * только тут живут Baileys-сокеты в памяти (между процессами их шарить нельзя).
 *
 * Каждая задача — отправить text в конкретный chatId через конкретного агента.
 * Если в этом процессе нет активного сокета для агента (он на другом поде или
 * только что упал) — бросаем ошибку, чтобы BullMQ ретрайнул на ESLB/после
 * восстановления сессии.
 *
 * Concurrency = WA_OUTBOUND_CONCURRENCY; per-chatId rate-limit реализован
 * внутри manager.send() (последовательно ждём интервал между сообщениями
 * одному и тому же чату). На разные чаты сообщения уходят параллельно.
 */
export function startOutboundWorker(manager: ConnectionManager): StartedWorker<WaOutboundJob> {
  return startWorker<WaOutboundJob>(
    QUEUE_WA_OUTBOUND,
    async (job: Job<WaOutboundJob>) => {
      const {
        agentId,
        chatId,
        text,
        humanize,
        targetReplyAtMs,
        isFirstBotReply
      } = job.data;
      const status = await manager.status(agentId);
      if (status.status !== "connected") {
        // Сокет ещё/уже не активен — пусть BullMQ повторит с backoff.
        // Это происходит, например, во время реконнекта после network blip.
        throw new Error(`Agent ${agentId} not connected (status=${status.status}); will retry`);
      }

      const humanizeOptions =
        humanize && targetReplyAtMs !== undefined && isFirstBotReply !== undefined
          ? { targetReplyAtMs, isFirstBotReply }
          : undefined;

      await manager.send(agentId, {
        chatId,
        text,
        ...(humanizeOptions ? { humanize: humanizeOptions } : {})
      });
    },
    {
      concurrency: env.WA_OUTBOUND_CONCURRENCY,
      lockDuration: env.WA_OUTBOUND_LOCK_MS
    }
  );
}
