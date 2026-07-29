import {
  getDeliveryQueue,
  getOutboundQueue,
  OUTBOUND_JOB_OPTIONS,
  QUEUE_WA_OUTBOUND,
  startWorker,
  type Job,
  type StartedWorker,
  type WaOutboundJob
} from "@jazu/queue";
import { captureError } from "@jazu/observability";
import { env } from "./env.js";
import type { ConnectionManager } from "./manager.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Сколько пузырей всего в этой задаче (мультисообщение или одиночный текст). */
function totalBubbles(data: WaOutboundJob): number {
  return data.texts && data.texts.length > 0 ? data.texts.length : 1;
}

/**
 * Репортит статус доставки одного пузыря в wa:delivery. Fire-and-forget:
 * wa-worker не имеет доступа к Postgres (см. QUEUE_WA_DELIVERY в packages/queue),
 * поэтому обновление статуса — best-effort задача в очередь, а не прямая запись.
 * Не блокирует и не роняет саму отправку — ошибку глушим с логом.
 */
function reportDeliveryStatus(
  outboundMessageId: string | undefined,
  index: number,
  status: "sent" | "failed",
  extra: { waMsgId?: string; error?: string } = {}
): void {
  if (!outboundMessageId) return;
  void getDeliveryQueue()
    .add("wa-delivery", { outboundMessageId, index, status, ...extra })
    .catch((err) => {
      console.warn(
        `[wa-outbound] failed to enqueue wa:delivery (outboundMessageId=${outboundMessageId}, index=${index}, status=${status}):`,
        err instanceof Error ? err.message : err
      );
    });
}

/**
 * Ждёт восстановления сокета до timeoutMs, опрашивая статус раз в 1.5с.
 * Реконнект после network blip укладывается в секунды, поэтому ждать на месте
 * дешевле, чем падать в ретрай: попытка не сгорает, а клиент получает хвост
 * ответа сразу, а не через очередной шаг backoff.
 */
async function waitForConnected(
  manager: ConnectionManager,
  agentId: string,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = (await manager.status(agentId)).status;
  while (status !== "connected" && Date.now() < deadline) {
    await sleep(1_500);
    status = (await manager.status(agentId)).status;
  }
  return status;
}

/**
 * Последний рубеж: все попытки выгорели, а хвост мультисообщения не доставлен.
 * Такое бывает, когда WhatsApp восстанавливает сессию дольше, чем живут ретраи
 * (~5 минут). Молча потерять хвост нельзя — клиент видит начало ответа и ждёт
 * продолжения, поэтому переставляем ОСТАТОК новой задачей с растущей паузой.
 * sentCount переносится, значит доставленные пузыри не повторятся.
 */
async function requeueUndelivered(job: Job<WaOutboundJob>, reason: string): Promise<void> {
  const data = job.data;
  const total = totalBubbles(data);
  const sent = data.sentCount ?? 0;
  if (sent >= total) return; // всё доставлено — задача упала уже на финализации

  const requeueCount = data.requeueCount ?? 0;
  if (requeueCount >= env.WA_OUTBOUND_REQUEUE_MAX) {
    const message = `ХВОСТ ПОТЕРЯН ${data.chatId}: доставлено ${sent}/${total} пузырей, добивка исчерпана (${requeueCount}/${env.WA_OUTBOUND_REQUEUE_MAX}). Причина: ${reason}`;
    console.error(`[wa-outbound] ${message}`);
    captureError(new Error(message), {
      agentId: data.agentId,
      route: "wa-worker:outbound-requeue",
      extra: { chatId: data.chatId, sent, total, requeueCount }
    });
    // Недоставленный хвост помечаем failed — иначе строки WaMessageDelivery
    // остаются в pending навсегда (сторожевой крон в apps/jobs их бы поймал
    // как "зависшие", хотя причина уже известна и записана здесь).
    for (let index = sent; index < total; index++) {
      reportDeliveryStatus(data.outboundMessageId, index, "failed", { error: reason.slice(0, 500) });
    }
    return;
  }

  const delay = 60_000 * 2 ** requeueCount; // 1 мин → 2 мин → 4 мин
  console.warn(
    `[wa-outbound] ${data.chatId}: доставлено ${sent}/${total}, попытки выгорели — ` +
      `переставляю остаток через ${Math.round(delay / 1000)}с (добивка ${requeueCount + 1}/${env.WA_OUTBOUND_REQUEUE_MAX}). Причина: ${reason}`
  );
  await getOutboundQueue().add(
    "wa-outbound",
    { ...data, requeueCount: requeueCount + 1 },
    { ...OUTBOUND_JOB_OPTIONS, delay }
  );
}

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
  const started = startWorker<WaOutboundJob>(
    QUEUE_WA_OUTBOUND,
    async (job: Job<WaOutboundJob>) => {
      const {
        agentId,
        chatId,
        text,
        texts,
        humanize,
        targetReplyAtMs,
        isFirstBotReply
      } = job.data;
      // Сокет может быть в реконнекте после network blip — ждём его на месте,
      // не сжигая попытку. Не дождались — уходим в ретрай с backoff; прогресс по
      // пузырям (sentCount) сохранён, поэтому повтор продолжит ответ, а не начнёт заново.
      const status = await waitForConnected(manager, agentId, env.WA_OUTBOUND_WAIT_RECONNECT_MS);
      if (status !== "connected") {
        throw new Error(`Agent ${agentId} not connected (status=${status}); will retry`);
      }

      const humanizeOptions =
        humanize && targetReplyAtMs !== undefined && isFirstBotReply !== undefined
          ? { targetReplyAtMs, isFirstBotReply }
          : undefined;

      const total = totalBubbles(job.data);
      const startIndex = typeof job.data.sentCount === "number" ? job.data.sentCount : 0;
      if (startIndex > 0) {
        console.warn(`[wa-outbound] resuming ${chatId}: ${startIndex}/${total} bubbles already delivered`);
      }

      await manager.send(agentId, {
        chatId,
        text,
        ...(texts && texts.length > 0 ? { texts } : {}),
        ...(humanizeOptions ? { humanize: humanizeOptions } : {}),
        startIndex,
        onBubbleSent: async (sentCount, waMsgId) => {
          // Прогресс пишем в данные задачи — их видит ретрай той же задачи.
          // Ошибку записи глушим: не доставить остаток ответа хуже, чем
          // рискнуть повтором одного пузыря при недоступном Redis.
          try {
            await job.updateData({ ...job.data, sentCount });
          } catch (err) {
            console.warn(
              `[wa-outbound] failed to persist bubble progress for ${chatId}:`,
              err instanceof Error ? err.message : err
            );
          }
          // Статус доставки в БД (best-effort, не блокирует цикл отправки).
          reportDeliveryStatus(job.data.outboundMessageId, sentCount - 1, "sent", {
            ...(waMsgId ? { waMsgId } : {})
          });
        }
      });

      if (total > 1) {
        console.log(`[wa-outbound] ${chatId}: доставлено ${total}/${total} пузырей`);
      }
    },
    {
      concurrency: env.WA_OUTBOUND_CONCURRENCY,
      lockDuration: env.WA_OUTBOUND_LOCK_MS,
      // Без явных значений сваливания задачи были полностью невидимы: BullMQ
      // переводит дважды сваленную задачу в failed БЕЗ инкремента attemptsMade,
      // а generic failed-логгер в startWorker() показывает только текст ошибки,
      // не факт сваливания. stalled-листенер ниже даёт отдельный сигнал в лог/Sentry.
      stalledInterval: 30_000,
      maxStalledCount: 2
    }
  );

  started.worker.on("stalled", (jobId) => {
    console.error(`[wa-outbound] job ${jobId} stalled (сокет/процесс не отвечал дольше lockDuration)`);
    captureError(new Error(`wa-outbound job stalled: ${jobId}`), {
      route: "wa-worker:outbound-stalled",
      extra: { jobId }
    });
  });

  // Финальный провал задачи (все попытки выгорели) с недоставленным хвостом —
  // единственный сценарий, где клиент навсегда остаётся с половиной ответа.
  // Переставляем остаток вместо молчания. Обработчик синхронный, поэтому
  // асинхронную добивку запускаем без await и глушим её ошибки.
  started.worker.on("failed", (job, err) => {
    if (!job) return;
    const attemptsAllowed = job.opts.attempts ?? 1;
    // "stalled" — двукратно сваленная задача уходит в failed БЕЗ инкремента
    // attemptsMade (BullMQ moveStalledJobsToWait), поэтому обычный гард по
    // attemptsMade её бы пропустил и хвост потерялся бы молча.
    const stalledFailure = /stalled/i.test(err?.message ?? "");
    if (!stalledFailure && job.attemptsMade < attemptsAllowed) return; // ретраи ещё будут
    captureError(err, {
      agentId: job.data?.agentId ?? null,
      route: "wa-worker:outbound-failed",
      extra: { chatId: job.data?.chatId, attemptsMade: job.attemptsMade, stalledFailure }
    });
    if (env.WA_OUTBOUND_REQUEUE_MAX === 0) return;
    void requeueUndelivered(job, err.message).catch((requeueErr) => {
      console.error(
        `[wa-outbound] не удалось переставить остаток для ${job.data?.chatId ?? "?"}:`,
        requeueErr instanceof Error ? requeueErr.message : requeueErr
      );
    });
  });

  return started;
}
