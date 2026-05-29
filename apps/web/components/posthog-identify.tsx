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
      posthog.identify(status.userId, {
        ...(status.email ? { email: status.email } : {}),
        ...(status.name ? { name: status.name } : {})
      });
    } else {
      if (lastKey.current === "anon") return;
      lastKey.current = "anon";
      posthog.reset();
    }
  }, [status]);

  return null;
}
