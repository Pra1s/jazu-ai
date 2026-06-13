"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

/**
 * Ловит рекламный click-id и UTM-метки из URL при заходе с рекламы и закрепляет
 * их за пользователем. Без этого click-id теряется на первом переходе и конверсию
 * (signup/whatsapp/purchase) невозможно вернуть в Google/Meta.
 *
 * - posthog.register(...)  — super properties: липнут ко ВСЕМ последующим
 *   событиям этой сессии (включая signup_completed после регистрации) и
 *   переживают перезагрузку. Из них relay читает click-id при отправке конверсии.
 * - posthog.setPersonProperties(undefined, ...) — $set_once на профиль:
 *   first-touch атрибуция, повторные заходы не перетирают первый источник.
 *
 * Рендерит null. Монтируется один раз в корневом layout рядом с PostHogIdentify.
 * Если меток в URL нет — ничего не делает (профиль не засоряем пустыми полями).
 */

// Рекламные идентификаторы клика: Google (gclid/gbraid/wbraid) и Meta (fbclid).
const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid", "fbclid"] as const;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export function AttributionCapture() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const captured: Record<string, string> = {};

    for (const key of [...CLICK_ID_KEYS, ...UTM_KEYS]) {
      const value = params.get(key);
      if (value) captured[key] = value;
    }

    // fbc в формате Meta (fb.1.<ts>.<fbclid>) — нужен серверному CAPI для матчинга.
    if (captured.fbclid && !captured.fbc) {
      captured.fbc = `fb.1.${Date.now()}.${captured.fbclid}`;
    }

    if (Object.keys(captured).length === 0) return;

    // Super properties — на все события сессии (+ персист в localStorage).
    posthog.register(captured);
    // Профиль: фиксируем первый источник, не перетирая при повторных заходах.
    posthog.setPersonProperties(undefined, captured);
  }, []);

  return null;
}
