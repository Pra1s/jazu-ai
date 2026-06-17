"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Связывает PostHog-события с конкретным пользователем.
 *
 * При логине → posthog.identify(userId, { email, name }) — все последующие
 * события привязываются к этому юзеру (нужно для воронок/ретеншна).
 * При логауте/госте → posthog.reset() — отвязываем, чтобы события не текли
 * на предыдущего юзера.
 *
 * Рендерит null. Вставляется один раз в корневой layout.
 */

// Рекламные click-id и UTM для first-touch атрибуции на ПРОФИЛЕ. СЕРВЕРНЫЕ
// конверсии (signup_completed/whatsapp_connected/bot_activated) эмитятся с бэка
// без этих меток, поэтому их relay (Meta CAPI / Google Ads) читает click-id с
// персоны. У анонима профиля нет (person_profiles: 'identified_only'), и метки
// живут только в super-properties; фиксируем их на персону ($set_once) ровно в
// момент identify, читая из super-properties (их кладёт attribution-capture +
// автозахват кампаний PostHog). $set_once = first-touch, повторные заходы не
// перетирают исходный источник.
const ATTRIBUTION_KEYS = [
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term"
] as const;

function collectAttribution(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value: unknown = posthog.get_property(key);
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

export function PostHogIdentify() {
  const status = useAuthStatus();
  // Чтобы не дёргать identify/reset на каждый ре-рендер — храним последнее
  // применённое состояние.
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (status === null) return; // ещё грузится — ждём

    if (status.ok) {
      const key = `id:${status.userId}`;
      if (lastKey.current === key) return;
      lastKey.current = key;
      const attribution = collectAttribution();
      posthog.identify(
        status.userId,
        {
          ...(status.email ? { email: status.email } : {}),
          ...(status.name ? { name: status.name } : {}),
          ...(status.phone ? { phone: status.phone } : {})
        },
        // $set_once: рекламный источник фиксируем первый раз и не перетираем.
        Object.keys(attribution).length > 0 ? attribution : undefined
      );
    } else {
      if (lastKey.current === "anon") return;
      lastKey.current = "anon";
      posthog.reset();
    }
  }, [status]);

  return null;
}
