import { z } from "zod";

const DEV_MAGIC_LINK_SECRET = "jazu-dev-magic-secret";
const DEV_INTERNAL_TOKEN = "jazu-internal-token";
// Pepper для HMAC-хэширования WA-номеров (анти-абуз: один номер — один аккаунт).
// В dev допускаем дефолт, в проде ОБЯЗАТЕЛЕН и НИКОГДА не меняется (иначе
// старые хэши перестанут совпадать с новыми и защита сломается).
const DEV_PHONE_HASH_PEPPER = "jazu-dev-phone-hash-pepper";

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  API_ORIGIN: z.string().url().default("http://localhost:3001"),
  REDIS_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  MAGIC_LINK_SECRET: z.string().min(16).default(DEV_MAGIC_LINK_SECRET),
  // Для бесшовной ротации MAGIC_LINK_SECRET. После выкатки нового CURRENT
  // ссылки, выданные старым ключом, ещё валидны 30 минут (TTL token'а), поэтому
  // _OLD держим до истечения TTL и удаляем.
  MAGIC_LINK_SECRET_OLD: z.string().min(16).optional(),
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  WA_WORKER_URL: z.string().url().optional(),
  API_INTERNAL_TOKEN: z.string().min(16).default(DEV_INTERNAL_TOKEN),
  // Для бесшовной ротации API_INTERNAL_TOKEN: API принимает оба, но wa-worker
  // и jobs шлют только CURRENT. Если _OLD не задан — проверка идёт только по CURRENT.
  API_INTERNAL_TOKEN_OLD: z.string().min(16).optional(),
  PHONE_HASH_PEPPER: z.string().min(32).default(DEV_PHONE_HASH_PEPPER),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  // Sentry: если не задан — observability работает в no-op режиме (только stderr).
  SENTRY_DSN: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  RELEASE_VERSION: z.string().optional()
});

const envSchema = baseSchema.superRefine((value, ctx) => {
  if (value.NODE_ENV !== "production") return;

  const requireOverride = (key: keyof typeof value, devDefault: unknown, label: string) => {
    if (value[key] === devDefault) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${label} must be overridden in production (cannot use dev default)`
      });
    }
  };

  const requireSet = (key: keyof typeof value, label: string) => {
    const v = value[key];
    if (v === undefined || v === null || v === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${label} is required in production`
      });
    }
  };

  requireOverride("MAGIC_LINK_SECRET", DEV_MAGIC_LINK_SECRET, "MAGIC_LINK_SECRET");
  requireOverride("API_INTERNAL_TOKEN", DEV_INTERNAL_TOKEN, "API_INTERNAL_TOKEN");
  requireOverride("PHONE_HASH_PEPPER", DEV_PHONE_HASH_PEPPER, "PHONE_HASH_PEPPER");
  requireSet("OPENAI_API_KEY", "OPENAI_API_KEY");
  requireSet("RESEND_API_KEY", "RESEND_API_KEY");
  requireSet("FROM_EMAIL", "FROM_EMAIL");
  requireSet("WA_WORKER_URL", "WA_WORKER_URL");
  // Google OAuth: либо все три выставлены, либо ни один (тогда фронт скрывает кнопку).
  const googleSet = [value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET, value.GOOGLE_REDIRECT_URI];
  const setCount = googleSet.filter((v) => v && v !== "").length;
  if (setCount !== 0 && setCount !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GOOGLE_CLIENT_ID"],
      message: "Google OAuth requires all of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI — or none"
    });
  }
});

export const env = envSchema.parse(process.env);
