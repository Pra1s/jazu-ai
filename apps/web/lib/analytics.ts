import posthog from "posthog-js";
import { API_BASE_URL } from "./api";

/**
 * Имена клиентских событий воронки привлечения — в одном месте, чтобы менялись
 * без охоты по компонентам и совпадали с тем, что выбираем целью конверсии в
 * рекламных кабинетах. Серверные события (signup_completed, whatsapp_connected,
 * purchase_completed) живут на бэкенде и сюда не входят.
 */
export const AnalyticsEvent = {
  LandingViewed: "landing_viewed",
  BuilderStarted: "builder_started",
  BuilderCompleted: "builder_completed",
  BotTestStarted: "bot_test_started",
  RegistrationOffered: "registration_offered"
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/** Причина показа CTA на регистрацию (свойство события registration_offered). */
export type TriggerReason = "lead_handoff" | "message_limit" | "three_edits";

/**
 * События, которые являются целями конверсии в Google Ads. Шлём их beacon-ом на
 * бэкенд РОВНО здесь же, где уходит PostHog-событие → данные в Google совпадают
 * с аналитикой по построению (один триггер). Сам аплоад в Google делает бэкенд
 * (S2S, см. apps/api/lib/google-ads.ts). Для не-Google трафика (нет gclid) beacon
 * не отправляется.
 */
const GOOGLE_CONVERSION_EVENTS: readonly AnalyticsEventName[] = [AnalyticsEvent.BuilderStarted];
const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid"] as const;

function reportGoogleAdsConversion(event: AnalyticsEventName): void {
  if (!GOOGLE_CONVERSION_EVENTS.includes(event)) return;
  try {
    const payload: Record<string, string> = { event };
    for (const key of CLICK_ID_KEYS) {
      const value: unknown = posthog.get_property(key);
      if (typeof value === "string" && value) payload[key] = value;
    }
    // Нет ни одного Google click-id => трафик не из Google Ads, слать нечего.
    if (!CLICK_ID_KEYS.some((k) => payload[k])) return;

    void fetch(`${API_BASE_URL}/track/ad-conversion`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => {
      /* аналитика молчит при сбое */
    });
  } catch {
    /* аналитика молчит при сбое */
  }
}

/**
 * Безопасная отправка события в PostHog (+ зеркало конверсии в Google Ads).
 * Никогда не бросает — аналитика не должна ронять UX. No-op, если PostHog не
 * инициализирован (dev без токена).
 */
export function track(event: AnalyticsEventName, properties?: Record<string, unknown>): void {
  try {
    posthog.capture(event, properties);
  } catch {
    /* аналитика молчит при сбое */
  }
  // Та же точка, что PostHog → Google = аналитика. No-op, если нет gclid.
  reportGoogleAdsConversion(event);
}
