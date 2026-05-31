"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { apiFetch, apiJson, API_BASE_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { resetAuthStatus } from "@/lib/use-auth-status";
import { persistNext } from "@/lib/safe-next";

const MAGIC_LINK_COOLDOWN_SECONDS = 30;

type Stage = "email" | "code";

type AuthDialogProps = {
  open: boolean;
  title: string;
  description: string;
  // Куда вернуть пользователя после ввода телефона (если он впервые).
  // Для тестового чата это обычно текущая страница (/dashboard).
  nextPath?: string;
  onClose: () => void;
  onSuccess?: () => void;
};

// Программно-открываемая модалка авторизации (email -> 6-значный код).
// В отличие от полностраничного AuthClient, после успешного входа без
// необходимости телефона зовёт onSuccess, не делая редиректа — чтобы юзер
// остался в тестовом чате. Если телефон ещё не введён — уводит на /auth/phone.
export default function AuthDialog({
  open,
  title,
  description,
  nextPath,
  onClose,
  onSuccess
}: AuthDialogProps) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"error" | "success">("success");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  // Email-вход — вторичный путь: показываем форму только по запросу,
  // чтобы Google оставался главным заметным CTA.
  const [showEmail, setShowEmail] = useState(false);
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    void apiJson<{ googleEnabled: boolean }>("/auth/config", { method: "GET" })
      .then((cfg) => setGoogleEnabled(Boolean(cfg.googleEnabled)))
      .catch(() => setGoogleEnabled(false));
  }, [open]);

  useEffect(() => {
    if (lockUntil <= now) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lockUntil, now]);

  useEffect(() => {
    if (stage === "code") {
      const t = window.setTimeout(() => codeInputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return;
  }, [stage]);

  const cooldownSecondsLeft = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  const cooldownActive = cooldownSecondsLeft > 0;

  function startCooldown(seconds: number) {
    setLockUntil(Date.now() + seconds * 1000);
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
        setMessageKind("error");
        setMessage(data?.message ?? data?.error ?? `Слишком часто. Подождите ${seconds} сек.`);
        return;
      }

      if (!response.ok || !data?.ok) {
        setMessageKind("error");
        setMessage(data?.error ?? data?.message ?? "Не удалось отправить код");
        return;
      }

      setStage("code");
      setCode("");
      setMessageKind("success");
      setMessage(
        data.devCode
          ? `Для теста: ${data.devCode}`
          : "Мы отправили 6-значный код на ваш email."
      );
      startCooldown(MAGIC_LINK_COOLDOWN_SECONDS);
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof Error ? err.message : "Не удалось отправить код");
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

      // Сбрасываем кэш /auth/me, чтобы каркас/гарды сразу увидели вход.
      resetAuthStatus();
      if (data.needsPhone) {
        // Телефон ещё не введён — уводим на страницу ввода, прокидывая next,
        // чтобы после телефона вернуть пользователя в исходную точку.
        const target = nextPath ? `/auth/phone?next=${encodeURIComponent(nextPath)}` : "/auth/phone";
        router.replace(target);
        return;
      }
      // Вход завершён — остаёмся на месте, отдаём управление наверх.
      onSuccess?.();
      onClose();
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : "Не удалось проверить код");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {stage === "email" && googleEnabled && (
          <>
            <Button
              className="h-12 w-full gap-2.5 text-base font-semibold"
              onClick={() => {
                persistNext(nextPath ?? null);
                window.location.href = `${API_BASE_URL}/auth/google/start`;
              }}
            >
              <GoogleLogo className="h-5 w-5" />
              Продолжить через Google
            </Button>
            {!showEmail && (
              <button
                type="button"
                onClick={() => setShowEmail(true)}
                className="mt-3 w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Или войти по email
              </button>
            )}
            {showEmail && (
              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                <span>вход по email</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
          </>
        )}

        {stage === "email" && (showEmail || !googleEnabled) ? (
          <div className="space-y-3">
            <div>
              <label htmlFor="auth-dialog-email" className="block text-sm font-medium text-foreground">
                Email
              </label>
              <input
                id="auth-dialog-email"
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
                Если входите впервые — попросим номер телефона на следующем шаге.
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
        ) : null}

        {stage === "code" && (
          <div className="space-y-3">
            <div>
              <label htmlFor="auth-dialog-code" className="block text-sm font-medium text-foreground">
                Код из письма
              </label>
              <input
                id="auth-dialog-code"
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
      </DialogContent>
    </Dialog>
  );
}

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.45c-.28 1.49-1.12 2.75-2.39 3.6v3h3.87c2.26-2.09 3.56-5.17 3.56-8.84z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.87-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.11C3.26 21.31 7.31 24 12 24z" />
      <path fill="#FBBC05" d="M5.29 14.29A7.2 7.2 0 014.9 12c0-.79.14-1.56.39-2.29V6.6H1.29A12 12 0 000 12c0 1.94.47 3.77 1.29 5.4l4-3.11z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.43-3.43C17.95 1.18 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.6l4 3.11C6.23 6.88 8.88 4.77 12 4.77z" />
    </svg>
  );
}
