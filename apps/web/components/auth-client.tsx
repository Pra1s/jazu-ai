"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Zap } from "lucide-react";
import { apiFetch, apiJson, API_BASE_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { cn } from "@/lib/cn";
import { resetAuthStatus } from "@/lib/use-auth-status";
import { persistNext, sanitizeNext } from "@/lib/safe-next";

const MAGIC_LINK_COOLDOWN_SECONDS = 30;
const COOLDOWN_STORAGE_KEY = "jazu_magic_link_lock_until";

function readPersistedLockUntil(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.sessionStorage.getItem(COOLDOWN_STORAGE_KEY);
  const ts = raw ? Number(raw) : 0;
  return Number.isFinite(ts) && ts > Date.now() ? ts : 0;
}

function persistLockUntil(ts: number) {
  if (typeof window === "undefined") return;
  if (ts > Date.now()) {
    window.sessionStorage.setItem(COOLDOWN_STORAGE_KEY, String(ts));
  } else {
    window.sessionStorage.removeItem(COOLDOWN_STORAGE_KEY);
  }
}

type Stage = "email" | "code";

export default function AuthClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Legacy: старые письма со ссылкой ?token=... продолжают работать через
  // GET /auth/callback. Сейчас новые письма ссылку не присылают, но если у
  // кого-то открыта старая ссылка в почте — она должна сработать.
  const token = searchParams.get("token");
  const errorParam = searchParams.get("error");
  // Куда вернуть юзера после входа (например, на /whatsapp из воронки
  // привязки). Принимаем только безопасные внутренние пути.
  const nextParam = sanitizeNext(searchParams.get("next"));
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"error" | "success">("success");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  // Время (epoch ms), до которого «Получить код» заблокирована.
  // Persists в sessionStorage, чтобы reload страницы не сбрасывал отсчёт.
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLockUntil(readPersistedLockUntil());
  }, []);

  useEffect(() => {
    if (lockUntil <= now) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lockUntil, now]);

  useEffect(() => {
    if (!token) return;
    window.location.href = `${API_BASE_URL}/auth/callback?token=${encodeURIComponent(token)}`;
  }, [token]);

  // Сохраняем next из query в sessionStorage сразу — чтобы он пережил
  // любой раундтрип (Google-OAuth, reload), даже если юзер пришёл по
  // email-коду.
  useEffect(() => {
    if (nextParam) persistNext(nextParam);
  }, [nextParam]);

  useEffect(() => {
    void apiJson<{ googleEnabled: boolean }>("/auth/config", { method: "GET" })
      .then((cfg) => setGoogleEnabled(Boolean(cfg.googleEnabled)))
      .catch(() => setGoogleEnabled(false));
  }, []);

  useEffect(() => {
    if (errorParam) {
      setMessageKind("error");
      setMessage(`Ошибка Google-входа: ${errorParam.replace(/^google_/, "")}`);
    }
  }, [errorParam]);

  useEffect(() => {
    if (stage === "code") {
      const t = window.setTimeout(() => codeInputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return;
  }, [stage]);

  const cooldownSecondsLeft = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  const cooldownActive = cooldownSecondsLeft > 0;

  function showError(text: string) {
    setMessageKind("error");
    setMessage(text);
  }

  function showSuccess(text: string) {
    setMessageKind("success");
    setMessage(text);
  }

  function startCooldown(seconds: number) {
    const ts = Date.now() + seconds * 1000;
    setLockUntil(ts);
    persistLockUntil(ts);
  }

  async function sendMagicCode() {
    if (!email.trim() || busy || cooldownActive) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/auth/magic-link", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() })
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; devCode?: string; message?: string }
        | null;

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const seconds =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(MAGIC_LINK_COOLDOWN_SECONDS, Math.ceil(retryAfter))
            : MAGIC_LINK_COOLDOWN_SECONDS;
        startCooldown(seconds);
        showError(
          data?.message ??
            data?.error ??
            `Слишком часто. Подождите ${seconds} сек.`
        );
        return;
      }

      if (!response.ok || !data?.ok) {
        showError(data?.error ?? data?.message ?? "Не удалось отправить код");
        return;
      }

      setStage("code");
      setCode("");
      showSuccess(
        data.devCode
          ? `Для теста: ${data.devCode}`
          : "Мы отправили 6-значный код на ваш email."
      );
      startCooldown(MAGIC_LINK_COOLDOWN_SECONDS);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Не удалось отправить код");
    } finally {
      setBusy(false);
    }
  }

  async function verifyMagicCode() {
    const trimmed = code.replace(/\s+/g, "");
    if (!trimmed || busy) return;
    setBusy(true);
    setCodeError(null);
    try {
      const response = await apiFetch("/auth/magic-link/verify", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), code: trimmed })
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; needsPhone?: boolean }
        | null;

      if (response.status === 429) {
        setCodeError(data?.error ?? "Слишком много попыток. Подождите минуту.");
        return;
      }

      if (!response.ok || !data?.ok) {
        setCodeError(data?.error ?? "Неверный или истёкший код");
        setCode("");
        return;
      }

      // Сбрасываем кэш /auth/me, чтобы SideNav и гарды сразу увидели вход.
      resetAuthStatus();
      if (data.needsPhone) {
        // Номер ещё не введён — прокидываем next дальше, чтобы после
        // /auth/phone вернуть юзера в исходную точку (например, /whatsapp).
        const target = nextParam ? `/auth/phone?next=${encodeURIComponent(nextParam)}` : "/auth/phone";
        router.replace(target);
      } else {
        router.replace(nextParam || "/dashboard");
      }
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : "Не удалось проверить код");
    } finally {
      setBusy(false);
    }
  }

  if (token) {
    return (
      <div className="mx-auto max-w-sm text-center">
        <div className="rounded-xl border border-border bg-card px-6 py-8">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
            <Zap className="h-5 w-5" />
          </div>
          <p className="text-sm text-muted-foreground">Входим…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-xl border border-border bg-card px-6 py-8">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-foreground">
            <Zap className="h-5 w-5 text-background" />
          </div>
          <h1 className="text-lg font-semibold">
            {stage === "email" ? "Войдите в Jazu" : "Введите код из письма"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {stage === "email"
              ? "Без пароля, отправим 6-значный код на ваш email"
              : `Отправили на ${email.trim()}`}
          </p>
        </div>

        {stage === "email" && googleEnabled && (
          <>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => {
                // Google делает редирект на провайдера и обратно на
                // /dashboard|/auth/phone — query-параметр next до нас не
                // доедет, поэтому кладём его в sessionStorage.
                persistNext(nextParam);
                window.location.href = `${API_BASE_URL}/auth/google/start`;
              }}
            >
              <GoogleLogo className="h-4 w-4" />
              Войти через Google
            </Button>
            <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              <span>или</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          </>
        )}

        {stage === "email" ? (
          <div className="space-y-3">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-foreground">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !cooldownActive) void sendMagicCode();
                }}
                placeholder="you@example.com"
                className={cn(
                  "mt-1.5 w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground",
                  "focus:border-foreground focus:ring-1 focus:ring-foreground/10"
                )}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Если входите впервые, попросим номер телефона на следующем шаге.
              </p>
            </div>

            <Button
              className="w-full"
              onClick={() => void sendMagicCode()}
              disabled={busy || cooldownActive || !email.trim()}
            >
              {busy
                ? "Отправляем…"
                : cooldownActive
                ? `Повторить через ${cooldownSecondsLeft} сек`
                : "Получить код"}
              {!busy && !cooldownActive && <ArrowRight className="h-4 w-4" />}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-foreground">
                Код из письма
              </label>
              <input
                id="code"
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D+/g, "").slice(0, 6));
                  if (codeError) setCodeError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void verifyMagicCode();
                }}
                placeholder="123456"
                aria-invalid={codeError ? true : undefined}
                className={cn(
                  "mt-1.5 w-full rounded-lg border bg-background px-3.5 py-2.5 text-center text-lg font-mono tracking-[0.4em] text-foreground outline-none transition placeholder:text-muted-foreground/50",
                  codeError
                    ? "border-red-400 focus:border-red-500 focus:ring-1 focus:ring-red-500/20"
                    : "border-border focus:border-foreground focus:ring-1 focus:ring-foreground/10"
                )}
              />
              {codeError && (
                <p className="mt-2 flex items-center gap-1 text-xs text-red-600">{codeError}</p>
              )}
            </div>

            <Button
              className="w-full"
              onClick={() => void verifyMagicCode()}
              disabled={busy || code.length < 4}
            >
              {busy ? "Проверяем…" : "Войти"}
              {!busy && <ArrowRight className="h-4 w-4" />}
            </Button>

            <div className="flex items-center justify-between gap-2 pt-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  setStage("email");
                  setCode("");
                  setCodeError(null);
                  setMessage(null);
                }}
                className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" />
                Изменить email
              </button>
              <button
                type="button"
                onClick={() => void sendMagicCode()}
                disabled={busy || cooldownActive}
                className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              >
                {cooldownActive
                  ? `Запросить ещё через ${cooldownSecondsLeft} сек`
                  : "Запросить новый код"}
              </button>
            </div>
          </div>
        )}

        {message && (
          <FormAlert variant={messageKind} className="mt-4">
            {message}
          </FormAlert>
        )}
      </div>
    </div>
  );
}

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.45c-.28 1.49-1.12 2.75-2.39 3.6v3h3.87c2.26-2.09 3.56-5.17 3.56-8.84z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.87-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.11C3.26 21.31 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.29A7.2 7.2 0 014.9 12c0-.79.14-1.56.39-2.29V6.6H1.29A12 12 0 000 12c0 1.94.47 3.77 1.29 5.4l4-3.11z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.43-3.43C17.95 1.18 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.6l4 3.11C6.23 6.88 8.88 4.77 12 4.77z"
      />
    </svg>
  );
}
