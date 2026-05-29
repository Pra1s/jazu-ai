import posthog from "posthog-js";

// Клиентский PostHog. Next.js 16 автоматически подхватывает
// instrumentation-client.ts и выполняет его на старте в браузере.
// Токен (phc_...) публичный — нормально, что он в бандле.
// Гард: если токен не задан (dev без аналитики) — не инициализируем.
const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (token) {
  posthog.init(token, {
    ...(host ? { api_host: host } : {}),
    defaults: "2026-01-30"
  });
}
