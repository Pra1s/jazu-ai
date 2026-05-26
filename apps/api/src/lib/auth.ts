import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

export type MagicLinkPayload = {
  email: string;
  issuedAt: number;
  nonce: string;
};

export const MAGIC_LINK_TTL_MS = 1000 * 60 * 30;
export const MAGIC_CODE_LENGTH = 6;
export const MAGIC_CODE_TTL_MS = 1000 * 60 * 15; // 15 минут, обычно достаточно

/**
 * Генерирует криптостойкий N-значный numeric-код. Используем randomInt вместо
 * Math.random — нужно равномерное распределение и непредсказуемость, иначе
 * атакующий мог бы перебирать «вероятные» коды.
 */
export function generateMagicCode(length: number = MAGIC_CODE_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String(randomInt(0, 10));
  }
  return out;
}

/**
 * Возвращает HMAC-хеш кода. В БД мы НЕ храним сам код — только хеш, чтобы
 * утечка БД не привела к компрометации непрочитанных писем. Соль здесь —
 * email юзера: даже если два юзера получили одинаковый код в одну секунду,
 * хеши будут разные.
 */
export function hashMagicCode(code: string, email: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${email.toLowerCase()}:${code}`)
    .digest("base64url");
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payload: MagicLinkPayload, secret: string): string {
  const body = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function createMagicLink(email: string, secret: string, origin: string): { token: string; link: string } {
  const token = signPayload({ email, issuedAt: Date.now(), nonce: randomUUID() }, secret);
  const link = new URL("/auth", origin);
  link.searchParams.set("token", token);
  return { token, link: link.toString() };
}

function verifyAgainstSecret(
  encodedPayload: string,
  signature: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

/**
 * Проверяет magic-link токен по CURRENT секрету; если не подходит — пробует
 * OLD (если задан). Это даёт бесшовную ротацию: в момент выкатки нового ключа
 * пользователи, кликнувшие по старому письму, всё ещё могут залогиниться,
 * пока их токен не истечёт по TTL (30 минут).
 */
export function verifyMagicLink(
  token: string,
  secret: string,
  oldSecret?: string
): MagicLinkPayload | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  let validSignature = verifyAgainstSecret(encodedPayload, signature, secret);
  if (!validSignature && oldSecret) {
    validSignature = verifyAgainstSecret(encodedPayload, signature, oldSecret);
  }
  if (!validSignature) {
    return null;
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload)) as MagicLinkPayload;
  if (Date.now() - payload.issuedAt > MAGIC_LINK_TTL_MS) {
    return null;
  }

  return payload;
}

/**
 * Constant-time-сравнение для x-internal-token. Принимает CURRENT и опционально
 * OLD — это позволяет ротировать токен без даунтайма wa-worker/jobs.
 *
 * 1) Выкатываем API с CURRENT=new, OLD=old.
 * 2) Все worker'ы продолжают слать old → API принимает.
 * 3) Выкатываем worker'ы с CURRENT=new.
 * 4) Удаляем OLD из env API.
 */
export function verifyInternalToken(
  provided: unknown,
  current: string,
  old: string | undefined
): boolean {
  if (typeof provided !== "string") return false;
  const providedBuf = Buffer.from(provided);
  const candidates = [current];
  if (old) candidates.push(old);
  for (const candidate of candidates) {
    const buf = Buffer.from(candidate);
    if (buf.length === providedBuf.length && timingSafeEqual(buf, providedBuf)) {
      return true;
    }
  }
  return false;
}

export function buildCookieOptions() {
  // SameSite=lax + httpOnly. В проде форсим secure (требует https). cookieId
  // — opaque UUID, в нём нет данных пользователя, его подменой пользователь
  // ничего не получает: вся истина (user, agent) лежит в Session-записи.
  // Поэтому signed не нужен, и мы экономим один секрет.
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    signed: false,
    maxAge: 60 * 60 * 24 * 30 // 30 days
  };
}

export function buildSessionCookie(cookieId: string) {
  return {
    name: "jazu_session_id",
    value: cookieId,
    options: buildCookieOptions()
  };
}

export function clearAuthCookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    signed: false,
    maxAge: 0
  };
}
