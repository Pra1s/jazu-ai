import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4001),
  API_ORIGIN: z.string().url().default("http://localhost:3001"),
  API_INTERNAL_TOKEN: z.string().min(16).default("jazu-internal-token"),
  /**
   * Опциональный OLD-токен для бесшовной ротации. Когда API катят с новым
   * CURRENT, worker'ы продолжают слать OLD до своей выкатки.
   */
  API_INTERNAL_TOKEN_OLD: z.string().min(16).optional(),
  // BullMQ-pipeline: если выставлено — voркер кладёт inbound в Redis вместо
  // синхронного HTTP-вызова /api/whatsapp/inbound и consume'ит wa:outbound.
  // Без REDIS_URL воркер автоматически фолбэкается на legacy HTTP-путь.
  REDIS_URL: z.string().optional(),
  /** Минимальный интервал между outgoing-сообщениями ОДНОМУ чату (мс). */
  WA_PER_CHAT_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(1_200),
  /** Параллельность consumer'а wa:outbound в одном процессе. */
  WA_OUTBOUND_CONCURRENCY: z.coerce.number().int().positive().default(8),
  /** BullMQ lockDuration для wa:outbound (job может ждать до 150с). */
  WA_OUTBOUND_LOCK_MS: z.coerce.number().int().positive().default(180_000),
  /** Включить humanize: read receipt, typing, задержку ответа. */
  WA_HUMANIZE_REPLIES: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v !== "false" && v !== "0")
    .default(true),
  WA_REPLY_DELAY_FIRST_MIN_MS: z.coerce.number().int().positive().default(45_000),
  WA_REPLY_DELAY_FIRST_MAX_MS: z.coerce.number().int().positive().default(60_000),
  WA_REPLY_DELAY_MIN_MS: z.coerce.number().int().positive().default(20_000),
  WA_REPLY_DELAY_MAX_MS: z.coerce.number().int().positive().default(35_000),
  WA_READ_DELAY_FIRST_MIN_MS: z.coerce.number().int().positive().default(5_000),
  WA_READ_DELAY_FIRST_MAX_MS: z.coerce.number().int().positive().default(15_000),
  WA_READ_DELAY_MIN_MS: z.coerce.number().int().positive().default(2_000),
  WA_READ_DELAY_MAX_MS: z.coerce.number().int().positive().default(6_000),
  WA_TYPING_FIRST_MIN_MS: z.coerce.number().int().positive().default(8_000),
  WA_TYPING_FIRST_MAX_MS: z.coerce.number().int().positive().default(20_000),
  WA_TYPING_MIN_MS: z.coerce.number().int().positive().default(5_000),
  WA_TYPING_MAX_MS: z.coerce.number().int().positive().default(12_000),
  SENTRY_DSN: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  RELEASE_VERSION: z.string().optional()
});

export const env = envSchema.parse(process.env);
