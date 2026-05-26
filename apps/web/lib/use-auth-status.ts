"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

/**
 * Хук статуса логина с module-level кэшем — все компоненты на странице
 * делят один запрос к `/auth/me`. Без этого SideNav и SidebarUserMenu
 * стреляли бы дважды на каждый рендер.
 *
 * Состояния:
 *   null                              — ещё не загрузили
 *   { ok: false }                     — гость
 *   { ok: true, needsPhone: boolean } — авторизован
 */

type AuthStatus = { ok: false } | { ok: true; needsPhone: boolean } | null;

let cached: AuthStatus = null;
let inflight: Promise<AuthStatus> | null = null;
const listeners = new Set<(status: AuthStatus) => void>();

async function fetchStatus(): Promise<AuthStatus> {
  try {
    const res = await apiFetch("/auth/me", { method: "GET" });
    if (res.status === 401) return { ok: false };
    const data = (await res.json()) as { success?: boolean; needsPhone?: boolean };
    if (!data.success) return { ok: false };
    return { ok: true, needsPhone: Boolean(data.needsPhone) };
  } catch {
    return { ok: false };
  }
}

async function ensureLoaded() {
  if (cached !== null) return cached;
  if (!inflight) {
    inflight = fetchStatus().then((status) => {
      cached = status;
      inflight = null;
      for (const l of listeners) l(status);
      return status;
    });
  }
  return inflight;
}

/** Сбросить кэш — вызывать после login/logout/изменения телефона, чтобы
 * навигация и гарды перерисовались без F5. Все подписчики получат
 * актуальное значение, как только fetchStatus вернётся. */
export function resetAuthStatus() {
  cached = null;
  inflight = null;
  // Уведомляем подписчиков о «сбросе» (null = «грузим заново»), чтобы UI мог
  // показать loading-состояние, и сразу пинаем новый fetch.
  for (const l of listeners) l(null);
  void ensureLoaded();
}

/** Низкоуровневая подписка для компонентов, которые не используют
 * useAuthStatus напрямую (например, SidebarUserMenu тянет свой расширенный
 * /auth/me со usage и хочет узнать о логине/логауте, чтобы перезагрузить
 * данные). Возвращает unsubscribe. */
export function subscribeAuthStatus(listener: (status: AuthStatus) => void): () => void {
  listeners.add(listener);
  // Сразу пинаем загрузку, если ещё не было.
  void ensureLoaded();
  return () => {
    listeners.delete(listener);
  };
}

export function useAuthStatus(): AuthStatus {
  const [status, setStatus] = useState<AuthStatus>(cached);

  useEffect(() => {
    const listener = (next: AuthStatus) => setStatus(next);
    listeners.add(listener);
    void ensureLoaded().then((s) => {
      if (cached === s) listener(s);
    });
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return status;
}
