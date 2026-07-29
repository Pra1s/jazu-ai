import { z } from "zod";

/**
 * Минимальный env для jobs-worker'а.
 *
 * Сервис ходит ТОЛЬКО в БД и Redis — никаких HTTP-эндпойнтов наружу не
 * поднимает. Поэтому секреты тут самые скудные.
 *
 *  - DATABASE_URL — обязательно, общее с api.
 *  - REDIS_URL    — обязательно, BullMQ без него не поедет.
 *  - OPENAI_API_KEY — для buildRuntimeTurn (внутри packages/ai).
 *  - TELEGRAM_BOT_TOKEN — опционально, для уведомлений о лидах.
 *  - JOBS_CONCURRENCY  — параллельность обработки wa:inbound в одном
 *                       процессе. Для масштабирования просто запускаем
 *                       несколько контейнеров вместо подкручивания.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required for jobs worker"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // wa-worker для отправки WA-уведомлений владельцу о новых лидах.
  // Опционально: если не задан, WA-уведомления не шлются (Telegram работает).
  WA_WORKER_URL: z.string().url().optional(),
  API_INTERNAL_TOKEN: z.string().optional(),
  JOBS_CONCURRENCY: z.coerce.number().int().positive().default(10),
  JOBS_INBOUND_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Порт встроенного Fastify под /healthz и /readyz. */
  JOBS_HEALTH_PORT: z.coerce.number().int().positive().default(4002),
  SENTRY_DSN: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  RELEASE_VERSION: z.string().optional(),
  // PostHog аналитика. Если токен не задан — capture становится no-op.
  POSTHOG_PROJECT_TOKEN: z.string().optional(),
  POSTHOG_HOST: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  /**
   * Retention в днях для логов: дальше WaMessage и LlmCallLog старше N дней
   * удаляются ночью cron-задачей. 0 = выключено.
   */
  RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
  WA_REPLY_DELAY_FIRST_MIN_MS: z.coerce.number().int().positive().default(30_000),
  WA_REPLY_DELAY_FIRST_MAX_MS: z.coerce.number().int().positive().default(35_000),
  WA_REPLY_DELAY_MIN_MS: z.coerce.number().int().positive().default(8_000),
  WA_REPLY_DELAY_MAX_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Склейка нескольких входящих клиента в ОДИН ответ бота (гибрид «тишина + потолок»):
   *  - WA_BATCH_QUIET_MS — период «тишины»: таймер ответа сбрасывается на каждое
   *    новое сообщение, бот ждёт паузу такой длины перед ответом.
   *  - WA_BATCH_MAX_MS — потолок: максимум ожидания от ПЕРВОГО неотвеченного
   *    сообщения (защищает от бесконечного откладывания, если клиент строчит без пауз).
   * См. apps/jobs/handlers/wa-inbound.ts (scheduleFlush) и wa-flush.ts.
   */
  WA_BATCH_QUIET_MS: z.coerce.number().int().positive().default(20_000),
  WA_BATCH_MAX_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Задержка отправки карточки лида владельцу (мс). Карточку придерживаем, чтобы
   * поймать «номер для связи», названный сразу после закрытия, и отправить ОДНУ
   * полную карточку. По умолчанию 120000 (2 мин); поставь 180000 для 3 мин.
   */
  LEAD_NOTIFY_DELAY_MS: z.coerce.number().int().positive().default(120_000),
  /**
   * Сторожевой таймер доставки мультисообщений (WaMessageDelivery): раз в
   * WA_DELIVERY_WATCHDOG_INTERVAL_MS ищет строки со статусом pending старше
   * WA_DELIVERY_STALE_MS и шлёт их в Sentry — иначе потеря пузыря невидима.
   * Пузырь может провисеть в pending дольше пары секунд легитимно (job ещё
   * в очереди/ретраится), поэтому порог заметно больше типичной отправки.
   */
  WA_DELIVERY_STALE_MS: z.coerce.number().int().positive().default(15 * 60_000),
  WA_DELIVERY_WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60_000)
});

export const env = schema.parse(process.env);
