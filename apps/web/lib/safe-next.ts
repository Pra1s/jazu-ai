/**
 * Безопасный разбор параметра `next` для редиректа после входа.
 *
 * Принимаем только внутренние относительные пути ("/whatsapp", "/dashboard"),
 * чтобы не превратить логин в open-redirect на чужой домен. Любое значение,
 * не начинающееся с одиночного "/", отбрасываем.
 */
export function sanitizeNext(value: string | null | undefined): string | null {
  if (!value) return null;
  // только относительный путь от корня: "/...", но не "//host" и не "/\\host"
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}

const NEXT_STORAGE_KEY = "jazu_post_login_next";

/** Сохранить next в sessionStorage — переживает Google-OAuth раундтрип. */
export function persistNext(value: string | null | undefined) {
  if (typeof window === "undefined") return;
  const safe = sanitizeNext(value);
  if (safe) {
    window.sessionStorage.setItem(NEXT_STORAGE_KEY, safe);
  } else {
    window.sessionStorage.removeItem(NEXT_STORAGE_KEY);
  }
}

/** Прочитать (и очистить) сохранённый next из sessionStorage. */
export function consumePersistedNext(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(NEXT_STORAGE_KEY);
  if (raw) {
    window.sessionStorage.removeItem(NEXT_STORAGE_KEY);
  }
  return sanitizeNext(raw);
}
