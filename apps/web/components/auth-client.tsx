"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Zap } from "lucide-react";
import { apiFetch, apiJson, API_BASE_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

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

export default function AuthClient() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const errorParam = searchParams.get("error");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  // Время (epoch ms), до которого кнопка «Получить ссылку» заблокирована.
  // Persists в sessionStorage, чтобы reload страницы не сбрасывал отсчёт.
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

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

  useEffect(() => {
    void apiJson<{ googleEnabled: boolean }>("/auth/config", { method: "GET" })
      .then((cfg) => setGoogleEnabled(Boolean(cfg.googleEnabled)))
      .catch(() => setGoogleEnabled(false));
  }, []);

  useEffect(() => {
    if (errorParam) {
      setMessage(`Ошибка Google-входа: ${errorParam.replace(/^google_/, "")}`);
    }
  }, [errorParam]);

  const cooldownSecondsLeft = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  const cooldownActive = cooldownSecondsLeft > 0;

  function startCooldown(seconds: number) {
    const ts = Date.now() + seconds * 1000;
    setLockUntil(ts);
    persistLockUntil(ts);
  }

  async function sendMagicLink() {
    if (!email.trim() || busy || cooldownActive) return;
    setBusy(true);
    setMessage(null);
    try {
      // apiFetch вместо apiJson: на 429 нам нужен и body, и Retry-After,
      // а apiJson бы просто бросил исключение и съел контекст.
      const response = await apiFetch("/auth/magic-link", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() })
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; magicLink?: string; message?: string }
        | null;

      if (response.status === 429) {
        // Берём Retry-After если бэк его прислал (fastify-rate-limit
        // выставляет автоматически), иначе фолбэк на полный кулдаун.
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const seconds =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(MAGIC_LINK_COOLDOWN_SECONDS, Math.ceil(retryAfter))
            : MAGIC_LINK_COOLDOWN_SECONDS;
        startCooldown(seconds);
        setMessage(
          data?.message ??
            data?.error ??
            `Слишком часто. Подождите ${seconds} сек.`
        );
        return;
      }

      if (!response.ok || !data?.ok) {
        setMessage(data?.error ?? data?.message ?? "Не удалось отправить ссылку");
        return;
      }
      setMessage(
        data.magicLink
          ? `Для теста: ${data.magicLink}`
          : "Проверьте почту — отправили ссылку для входа."
      );
      // После успешной отправки блокируем кнопку на полный кулдаун —
      // даже если бэкенд почему-то не вернул бы 429 на повторный клик.
      startCooldown(MAGIC_LINK_COOLDOWN_SECONDS);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Не удалось отправить ссылку");
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
          <h1 className="text-lg font-semibold">Войдите в Jazu</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Без пароля — отправим ссылку для входа на ваш email
          </p>
        </div>

        {googleEnabled && (
          <>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => {
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
                if (e.key === "Enter" && !cooldownActive) void sendMagicLink();
              }}
              placeholder="you@example.com"
              className={cn(
                "mt-1.5 w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground",
                "focus:border-foreground focus:ring-1 focus:ring-foreground/10"
              )}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Если входите впервые — попросим номер телефона на следующем шаге.
            </p>
          </div>

          <Button
            className="w-full"
            onClick={() => void sendMagicLink()}
            disabled={busy || cooldownActive || !email.trim()}
          >
            {busy
              ? "Отправляем…"
              : cooldownActive
              ? `Повторить через ${cooldownSecondsLeft} сек`
              : "Получить ссылку"}
            {!busy && !cooldownActive && <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>

        {message && (
          <div className="mt-4 rounded-lg bg-secondary px-4 py-3 text-sm text-foreground">
            {message}
          </div>
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
