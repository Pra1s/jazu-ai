import { Queue, Worker, type Processor, type QueueOptions, type WorkerOptions } from "bullmq";
import { buildRedisForWorker, getRedisWriter } from "./redis.js";

/**
 * Имена и payload-схемы всех очередей платформы.
 *
 * Дизайн pipeline'а WhatsApp:
 *
 *   Baileys messages.upsert
 *        │
 *        ▼ enqueue (моментально, не блокирует socket)
 *   ┌──────────────┐
 *   │  wa:inbound  │  ← обрабатывает apps/jobs: dedupe + квота + LLM + persist
 *   └──────┬───────┘
 *          │ on success enqueue reply
 *          ▼
 *   ┌──────────────┐
 *   │  wa:outbound │  ← обрабатывает apps/wa-worker: единственное место,
 *   └──────┬───────┘    где живёт Baileys-сокет; concurrency=1 + rate-limit
 *          ▼
 *   socket.sendMessage()
 *
 * Преимущества:
 *  - Baileys event loop остаётся «холодным» — никаких HTTP-fetch / LLM-ожиданий
 *    внутри Baileys-хендлера, поэтому WA-сокет не разваливается под нагрузкой.
 *  - apps/jobs можно скейлить горизонтально: добавил ещё один контейнер с
 *    тем же кодом — concurrency удвоилась.
 *  - Outbound идёт строго через один процесс (wa-worker), потому что Baileys
 *    хранит in-memory сокеты, и шарить их между подами нельзя.
 *  - Retry, backoff и dedupe — встроены в BullMQ.
 */

// BullMQ запрещает символ `:` в имени очереди (он использует двоеточие как
// разделитель в Redis-ключах), поэтому отделяем сегменты дефисом.
export const QUEUE_WA_INBOUND = "wa-inbound";
export const QUEUE_WA_OUTBOUND = "wa-outbound";

export type WaInboundJob = {
  agentId: string;
  chatId: string;
  senderName?: string;
  message: string;
  waMessageId?: string;
  /**
   * id текущего worker-сокета, чтобы при race-condition (старый сокет успел
   * положить задачу, но юзер уже перепривязал бота к новому номеру) jobs мог
   * отбросить устаревшее сообщение без ответа.
   */
  workerSessionId?: string;
  /** Unix-секунды, когда оригинальное сообщение было отправлено клиентом
   *  (Baileys: message.messageTimestamp). Используется, чтобы не отвечать
   *  на history-sync (старые сообщения, которые WhatsApp присылает пачкой
   *  при connection). См. WaConnection.botRespondsSince. */
  messageTimestamp?: number;
  /** request-id для end-to-end-трассировки (HTTP → BullMQ → log → SSE). */
  requestId?: string;
};

export type WaOutboundJob = {
  agentId: string;
  chatId: string;
  text: string;
  /** id оригинального inbound (для трассировки и dedupe outgoing). */
  inboundJobId?: string;
  /** Прокидываем request-id дальше — чтобы wa-worker логировал тот же reqId. */
  requestId?: string;
  /** Unix ms — когда клиент отправил inbound (для humanize-тайминга). */
  inboundReceivedAtMs?: number;
  /** Unix ms — целевое время ответа (фиксируется при enqueue). */
  targetReplyAtMs?: number;
  /** Первый ответ бота в этом чате — влияет на typing-диапазон. */
  isFirstBotReply?: boolean;
  /** Включить задержку, read receipt fallback и typing перед send. */
  humanize?: boolean;
  /** id inbound-сообщения (fallback read receipt в outbound). */
  waMessageId?: string;
  /** participant для group-чатов (read receipt). */
  participant?: string;
};

const DEFAULT_QUEUE_OPTIONS: Omit<QueueOptions, "connection"> = {
  defaultJobOptions: {
    // Successful jobs — храним сутки + не больше 1000 штук, чтобы Redis не
    // распух при больших нагрузках.
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    // Failed — держим неделю, чтобы можно было дебажить.
    removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    attempts: 5,
    backoff: { type: "exponential", delay: 2_000 }
  }
};

/** Кэш Queue-инстансов: один Queue на имя на процесс — это безопасно. */
const queues = new Map<string, Queue>();

export function getQueue<TPayload>(name: string): Queue<TPayload> {
  const existing = queues.get(name);
  if (existing) return existing as Queue<TPayload>;
  const queue = new Queue<TPayload>(name, {
    ...DEFAULT_QUEUE_OPTIONS,
    connection: getRedisWriter()
  });
  queues.set(name, queue);
  return queue;
}

export function getInboundQueue(): Queue<WaInboundJob> {
  return getQueue<WaInboundJob>(QUEUE_WA_INBOUND);
}

export function getOutboundQueue(): Queue<WaOutboundJob> {
  return getQueue<WaOutboundJob>(QUEUE_WA_OUTBOUND);
}

export type StartedWorker<T> = {
  worker: Worker<T>;
  close: () => Promise<void>;
};

/**
 * Создаёт BullMQ Worker с dedicated Redis-соединением.
 * Возвращает удобный `close()` для graceful shutdown.
 */
export function startWorker<T>(
  name: string,
  processor: Processor<T>,
  options: Partial<WorkerOptions> = {}
): StartedWorker<T> {
  const connection = buildRedisForWorker();
  const worker = new Worker<T>(name, processor, {
    connection,
    concurrency: options.concurrency ?? 5,
    ...options
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[queue:${name}] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? 0}/${job?.opts.attempts ?? 0}):`,
      err.message
    );
  });

  worker.on("error", (err) => {
    console.error(`[queue:${name}] worker error:`, err.message);
  });

  return {
    worker,
    close: async () => {
      // BullMQ Worker.close() ждёт завершения текущих jobs.
      await worker.close().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    }
  };
}

export async function closeAllQueues(): Promise<void> {
  for (const q of queues.values()) {
    await q.close().catch(() => undefined);
  }
  queues.clear();
}
