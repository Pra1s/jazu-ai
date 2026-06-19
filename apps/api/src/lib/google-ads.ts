import { randomUUID } from "node:crypto";
import { env } from "../env.js";

/**
 * Серверная прокидка конверсий в Google Ads через **Data Manager API**
 * (events:ingest). Старый ConversionUploadService.uploadClickConversions закрыт
 * для новых аккаунтов (CUSTOMER_NOT_ALLOWLISTED) — Google перевёл новые интеграции
 * на Data Manager API.
 *
 * Триггер прилетает с клиента (beacon из lib/analytics.ts ровно в точке события
 * воронки — то же, что уходит в PostHog), а ingest делаем серверно (S2S). Данные
 * в Google совпадают с аналитикой по построению (один триггер), вызов не зависит
 * от адблоков.
 *
 * Конфиг — через env (см. env.ts, префикс GOOGLE_ADS_). developer-token Data
 * Manager НЕ требует — нужны OAuth-креды (refresh token со scope `datamanager`),
 * operating account (рекламный), login account (MCC) и productDestinationId
 * (id conversion action типа UPLOAD_CLICKS). Не задан конфиг — no-op.
 */

const INGEST_URL = "https://datamanager.googleapis.com/v1/events:ingest";

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (!env.GOOGLE_ADS_CLIENT_ID || !env.GOOGLE_ADS_CLIENT_SECRET || !env.GOOGLE_ADS_REFRESH_TOKEN) {
    return null;
  }
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token"
    }).toString()
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3000) * 1000 };
  return json.access_token;
}

export type AdClickIds = {
  gclid?: string | undefined;
  gbraid?: string | undefined;
  wbraid?: string | undefined;
};

export function googleAdsConfigured(): boolean {
  return Boolean(
    env.GOOGLE_ADS_REFRESH_TOKEN && env.GOOGLE_ADS_CUSTOMER_ID && env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
  );
}

/** Имя события воронки -> id conversion action (productDestinationId). Пусто = не конверсия. */
export function conversionActionForEvent(event: string): string | undefined {
  const map: Record<string, string | undefined> = {
    builder_started: env.GOOGLE_ADS_CONVERSION_BUILDER_STARTED,
    builder_completed: env.GOOGLE_ADS_CONVERSION_BUILDER_COMPLETED
  };
  return map[event];
}

/**
 * Шлёт одну кликовую конверсию через Data Manager API events:ingest.
 * Никогда не бросает — возвращает результат. Идентификатор: gclid (приоритет),
 * иначе gbraid/wbraid.
 */
export async function uploadAdConversion(opts: {
  conversionActionId: string; // productDestinationId
  clickIds: AdClickIds;
  when?: Date;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const operatingAccountId = env.GOOGLE_ADS_CUSTOMER_ID;
    const loginAccountId = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    if (!operatingAccountId || !loginAccountId) return { ok: false, error: "google-ads not configured" };

    const { gclid, gbraid, wbraid } = opts.clickIds;
    const adIdentifiers: Record<string, string> = {};
    if (gclid) adIdentifiers.gclid = gclid;
    else if (gbraid) adIdentifiers.gbraid = gbraid;
    else if (wbraid) adIdentifiers.wbraid = wbraid;
    if (Object.keys(adIdentifiers).length === 0) return { ok: false, error: "no click id" };

    const token = await getAccessToken();
    if (!token) return { ok: false, error: "no access token" };

    const requestBody = {
      destinations: [
        {
          operatingAccount: { accountType: "GOOGLE_ADS", accountId: operatingAccountId },
          loginAccount: { accountType: "GOOGLE_ADS", accountId: loginAccountId },
          productDestinationId: opts.conversionActionId
        }
      ],
      events: [
        {
          eventTimestamp: (opts.when ?? new Date()).toISOString(),
          transactionId: randomUUID(),
          adIdentifiers,
          eventSource: "WEB"
        }
      ]
    };

    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 400) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
