import posthog from "posthog-js";

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
 * Безопасная отправка события в PostHog. Никогда не бросает — аналитика не
 * должна ронять UX. No-op, если PostHog не инициализирован (dev без токена).
 */
export function track(event: AnalyticsEventName, properties?: Record<string, unknown>): void {
  try {
    posthog.capture(event, properties);
  } catch {
    /* аналитика молчит при сбое */
  }
}
