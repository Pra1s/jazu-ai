import { PostHog } from "posthog-node";

/**
 * Серверный PostHog-клиент (singleton на процесс).
 *
 * Лежит в observability, чтобы быть доступным и из api (login/purchase/...
 * через зеркало recordAudit), и из jobs (lead_created — лид рождается в
 * jobs-воркере).
 *
 * Если токен не задан — клиент не создаётся, и все capture становятся no-op
 * (как Sentry без DSN). Удобно для dev'а / окружений без аналитики.
 */

let client: PostHog | null = null;

export type PostHogInitOptions = {
  /** Project token (phc_...). Если пусто — PostHog в no-op. */
  token: string | undefined;
  /** Self-hosted host (https://analytics.jazu.chat). */
  host: string | undefined;
};

/**
 * Инициализирует серверный PostHog. Идемпотентна — повторный вызов игнорится.
 * flushAt/flushInterval как в инструкции: батчим по 20 событий или раз в 10с.
 */
export function initPostHog(opts: PostHogInitOptions): void {
  if (client) return;
  if (!opts.token) return;
  client = new PostHog(opts.token, {
    ...(opts.host ? { host: opts.host } : {}),
    flushAt: 20,
    flushInterval: 10_000
  });
}

/**
 * Безопасно отправить событие. No-op если PostHog не инициализирован.
 * Никогда не бросает — аналитика не должна валить бизнес-логику.
 */
export function capturePostHog(params: {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}): void {
  if (!client) return;
  try {
    client.capture({
      distinctId: params.distinctId,
      event: params.event,
      ...(params.properties ? { properties: params.properties } : {})
    });
  } catch (err) {
    console.error("[observability] posthog capture failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Flush + закрытие клиента. Вызывать ТОЛЬКО из graceful shutdown
 * (НЕ после каждого запроса — singleton переиспользуется).
 */
export async function shutdownPostHog(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    // Не критично — PostHog не должен ломать shutdown процесса.
  }
}
