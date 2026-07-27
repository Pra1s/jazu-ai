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
// Отложенный «flush» диалога: склейка нескольких входящих клиента в ОДИН ответ.
// Каждое входящее (после ingest) ставит/пересоздаёт одну отложенную задачу на чат
// (jobId = `flush:<agentId>:<chatId>`), таймер сбрасывается на каждое сообщение
// (гибрид «тишина + потолок»). Когда окно закрылось — handleWaFlush собирает все
// неотвеченные входящие и зовёт LLM один раз. См. apps/jobs/handlers/wa-flush.ts.
export const QUEUE_WA_FLUSH = "wa-flush";
// Отложенная отправка карточки лида владельцу. Карточку придерживаем на пару
// минут после закрытия лида, чтобы поймать «номер для связи» (его называют сразу
// после закрытия) и отправить ОДНУ полную карточку, а не две. См.
// wa-pipeline: writeLeadIfNeeded (enqueue) → notifyLeadById (consumer в jobs).
export const QUEUE_LEAD_NOTIFY = "lead-notify";
// Анализ стиля владельца (фича «бот в стиле владельца»): сотни LLM-вызовов, в HTTP
// держать нельзя. Задача — прогнать оба прохода анализа над эпизодами, сохранёнными
// в StyleAnalysis.episodes. Обрабатывает apps/jobs: handleStyleAnalyze.
export const QUEUE_STYLE_ANALYZE = "style-analyze";
// Дожим клиента (follow-up): отложенная задача на чат (jobId = `followup:<agentId>:<chatId>`),
// ставится при ответе бота, отменяется при входящем клиента. Хендлер шлёт напоминание
// (пресет или авто LLM+RAG) и планирует следующий шаг серии. См. apps/jobs/handlers/followup.ts.
export const QUEUE_WA_FOLLOWUP = "wa-followup";

export type WaInboundJob = {
  agentId: string;
  chatId: string;
  senderName?: string;
  /** Реальный телефон клиента (цифры), резолвнутый воркером из ключа сообщения
   *  (для @lid-чатов chatId номером не является — см. wa-pipeline/phone.ts). */
  senderPhone?: string;
  message: string;
  /** Голосовое сообщение: декодированные байты media в base64. Текста при этом
   *  нет (message=""), распознавание делает wa-pipeline (Gemini → OpenAI). */
  audioBase64?: string;
  /** MIME аудио из Baileys (обычно "audio/ogg; codecs=opus"). */
  audioMimeType?: string;
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
  /**
   * Сообщение написано ВЛАДЕЛЬЦЕМ вручную со своего телефона (Baileys
   * `key.fromMe`), а не клиентом. Такие задачи не идут в обычный ingest: их
   * обрабатывает `ingestOwnerOutbound` — пишет реплику как исходящую и
   * закрывает ей неотвеченный пакет, чтобы бот не отвечал следом за человеком.
   * Свои же отправки бот в очередь не кладёт (Baileys помечает их `append`).
   */
  fromOwner?: boolean;
  /** request-id для end-to-end-трассировки (HTTP → BullMQ → log → SSE). */
  requestId?: string;
};

export type WaOutboundJob = {
  agentId: string;
  chatId: string;
  /** Полный текст ответа (склейка пузырей) — для обратной совместимости/логов. */
  text: string;
  /** Мультисообщения: список пузырей для последовательной отправки с паузами.
   *  Если пусто/один — шлём как одно сообщение (text). */
  texts?: string[];
  /**
   * Сколько пузырей из `texts` уже РЕАЛЬНО доставлено. Пишется воркером после
   * каждого успешного sendMessage (job.updateData), поэтому переживает ретрай.
   *
   * Зачем: отправка мультисообщения — одна задача, а обрыв сокета возможен между
   * пузырями. Без прогресса ретрай начинал ответ заново (клиент получал первое
   * сообщение дважды), а выгорание попыток теряло хвост — клиент видел только
   * начало ответа и ждал продолжения, которого уже не будет.
   */
  sentCount?: number;
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

export type LeadNotifyJob = {
  /** Лид, по которому шлём карточку владельцу. */
  leadId: string;
  /** Агент-владелец лида (нужен для загрузки получателя уведомления). */
  agentId: string;
};

export type WaFlushJob = {
  /** Агент, в чьём диалоге склеиваем входящие. */
  agentId: string;
  /** WhatsApp-чат (remoteJid) клиента. */
  chatId: string;
  /** request-id для сквозной трассировки (наследуется от inbound, если был). */
  requestId?: string;
};

export type StyleAnalyzeJob = {
  /** Агент, для которого гоним анализ стиля (эпизоды лежат в StyleAnalysis.episodes). */
  agentId: string;
  /**
   * Прогон запущен из истории WhatsApp: буфер WaHistoryChat нужно очистить ТОЛЬКО
   * после успешного анализа (не при постановке в очередь), иначе при ошибке ввод
   * теряется безвозвратно — история приходит лишь при переподключении номера.
   */
  clearHistoryOnSuccess?: boolean;
  /**
   * Дозагрузка: прежние карточки/векторы стиля сохраняются, анализируются только
   * новые диалоги, а паспорт стиля пересобирается по старым + новым. Без флага —
   * прогон с нуля (прежний стиль стирается).
   */
  append?: boolean;
};

export type FollowupJob = {
  /** Агент, чей бот дожимает клиента. */
  agentId: string;
  /** WhatsApp-чат (remoteJid) клиента. */
  chatId: string;
  /** Номер шага серии (0-based): индекс в followupSteps, дальше — repeat-хвост. */
  attempt: number;
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

/**
 * Опции задач wa:outbound. Попыток больше и шаг длиннее, чем в общем дефолте
 * (5 попыток с шагом 2с = всего ~30 секунд): между пузырями мультисообщения
 * возможен реконнект сокета, а WhatsApp восстанавливает сессию заметно дольше.
 * На дефолте попытки выгорали раньше реконнекта, и клиент навсегда оставался с
 * началом ответа. Здесь запас ~5 минут; повторы безопасны, потому что прогресс
 * по пузырям хранится в `WaOutboundJob.sentCount`.
 */
export const OUTBOUND_JOB_OPTIONS = {
  attempts: 7,
  backoff: { type: "exponential" as const, delay: 5_000 }
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

export function getLeadNotifyQueue(): Queue<LeadNotifyJob> {
  return getQueue<LeadNotifyJob>(QUEUE_LEAD_NOTIFY);
}

export function getFlushQueue(): Queue<WaFlushJob> {
  return getQueue<WaFlushJob>(QUEUE_WA_FLUSH);
}

export function getStyleAnalyzeQueue(): Queue<StyleAnalyzeJob> {
  return getQueue<StyleAnalyzeJob>(QUEUE_STYLE_ANALYZE);
}

export function getFollowupQueue(): Queue<FollowupJob> {
  return getQueue<FollowupJob>(QUEUE_WA_FOLLOWUP);
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
