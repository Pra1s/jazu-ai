import { createHmac } from "node:crypto";
import { env } from "../env.js";
import { normalizeKzRuPhone } from "./phone.js";

/**
 * HMAC-SHA256 от нормализованного номера для WaPhoneClaim.
 *
 * Зачем HMAC, а не plain SHA-256: телефон — низкоэнтропийный (~10^10
 * вариантов), plain SHA брутится за минуты на одной GPU. Pepper хранится
 * только в env (никогда в БД) — даже при утечке таблицы хэши необратимы.
 *
 * Pepper НЕ ротируется: иначе старые claim'ы перестанут сходиться с новыми
 * хэшами. Если когда-нибудь нужна ротация — потребуется rehash backfill
 * с обоими секретами.
 *
 * Лежит в отдельном файле от `phone.ts` намеренно: phone.ts чисто-функциональный
 * и не тащит env, поэтому юнит-тесты phone.test.ts не требуют DATABASE_URL.
 */
export function hashWaPhone(phone: string): string {
  const normalized = normalizeKzRuPhone(phone);
  if (!normalized) {
    throw new Error(`hashWaPhone: invalid phone format: ${phone}`);
  }
  return createHmac("sha256", env.PHONE_HASH_PEPPER).update(normalized).digest("hex");
}
