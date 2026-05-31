"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Bell, Phone } from "lucide-react";
import { apiFetch, apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { cn } from "@/lib/cn";
import { resetAuthStatus } from "@/lib/use-auth-status";
import { consumePersistedNext, sanitizeNext } from "@/lib/safe-next";

const PHONE_HINT = "Например: +7 701 123 45 67";

function formatPhoneInput(raw: string): string {
  const digits = raw.replace(/\D+/g, "").slice(0, 11);
  if (!digits) return "";
  const tail = digits.startsWith("7") || digits.startsWith("8") ? digits.slice(1) : digits;
  const padded = tail.padEnd(10, " ");
  const parts = [padded.slice(0, 3), padded.slice(3, 6), padded.slice(6, 8), padded.slice(8, 10)]
    .map((p) => p.replace(/\s+$/g, ""))
    .filter((p) => p.length > 0);
  return `+7 ${parts.join(" ")}`.trimEnd();
}

export default function PhoneCaptureClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Куда вернуть после ввода номера: query ?next=… (от /auth) или
  // сохранённый в sessionStorage (Google-OAuth раундтрип). Только
  // безопасные внутренние пути. Вычисляем один раз: consumePersistedNext()
  // очищает storage, поэтому нельзя дёргать его на каждом рендере.
  const [nextTarget] = useState<string>(
    () => sanitizeNext(searchParams.get("next")) ?? consumePersistedNext() ?? "/dashboard"
  );
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  // Двухэтапная верификация: phone -> (если номер != номер бота) -> code.
  const [stage, setStage] = useState<"phone" | "code">("phone");
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<string | null>(null);

  // Если юзер уже залогинен и у него уже есть phone — сразу в dashboard.
  // Если не залогинен — на /auth (логин).
  useEffect(() => {
    let cancelled = false;
    void apiJson<{ success: boolean; needsPhone?: boolean }>("/auth/me", { method: "GET" })
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          router.replace("/auth");
          return;
        }
        if (res.needsPhone === false) {
          router.replace(nextTarget);
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        if (cancelled) return;
        router.replace("/auth");
      });
    return () => {
      cancelled = true;
    };
  }, [router, nextTarget]);

  // Пока юзер на этой странице (то есть телефона ещё нет), предупреждаем
  // о закрытии вкладки. Браузер сам покажет нативный диалог подтверждения.
  // Глобальный гард PhoneRequiredGuard перехватит попытку перейти на другой
  // маршрут внутри SPA — beforeunload же закрывает «дыру» с закрытием
  // вкладки и hard-navigation.
  useEffect(() => {
    if (checking) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [checking]);

  async function submit() {
    if (!phone.trim() || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // verify-start: бэк сравнивает номер с номером бота. Если совпал —
      // сразу верифицирован. Если нет — шлёт код с номера бота и просит ввод.
      const response = await apiFetch("/auth/phone/verify-start", {
        method: "POST",
        body: JSON.stringify({ phone: phone.trim() })
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; verified?: boolean; codeSent?: boolean }
        | null;
      if (!response.ok || !data?.ok) {
        setError(data?.error ?? "Не удалось сохранить номер");
        if (response.status === 409) setPhone("");
        return;
      }
      if (data.verified) {
        // Номер совпал с номером бота — верификация не нужна.
        resetAuthStatus();
        router.replace(nextTarget);
        return;
      }
      // Код отправлен — переходим к вводу.
      setStage("code");
      setInfo("Мы отправили код на ваш WhatsApp с номера бота.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить номер");
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode() {
    const trimmed = code.replace(/\D+/g, "");
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/auth/phone/verify-confirm", {
        method: "POST",
        body: JSON.stringify({ code: trimmed })
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !data?.ok) {
        setError(data?.error ?? "Неверный код");
        setCode("");
        return;
      }
      resetAuthStatus();
      router.replace(nextTarget);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось проверить код");
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="rounded-2xl border border-border bg-card px-6 py-5 text-sm text-muted-foreground">
        Проверяем сессию…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-xl border border-border bg-card px-6 py-8">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-foreground">
            <Phone className="h-5 w-5 text-background" />
          </div>
          <h1 className="text-lg font-semibold">
            {stage === "code" ? "Подтвердите номер" : "Добавьте личный номер"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {stage === "code"
              ? "Мы отправили код на ваш WhatsApp с номера бота."
              : "На этот номер мы будем писать в WhatsApp о новых лидах от вашего бота."}
          </p>
        </div>

        {stage === "code" ? (
          <div className="space-y-3">
            <div>
              <label htmlFor="verify-code" className="block text-sm font-medium text-foreground">
                Код из WhatsApp
              </label>
              <p className="mt-1 mb-1.5 text-xs text-muted-foreground">
                Введите 6-значный код, который пришёл на {phone} с номера бота.
              </p>
              <input
                id="verify-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D+/g, "").slice(0, 6));
                  if (error) setError(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && void confirmCode()}
                placeholder="123456"
                className={cn(
                  "mt-1.5 w-full rounded-lg border bg-background px-3.5 py-2.5 text-center text-lg font-mono tracking-[0.4em] text-foreground outline-none transition placeholder:text-muted-foreground/50",
                  error
                    ? "border-red-400 focus:border-red-500 focus:ring-1 focus:ring-red-500/20"
                    : "border-border focus:border-foreground focus:ring-1 focus:ring-foreground/10"
                )}
              />
            </div>
            <Button className="w-full" onClick={() => void confirmCode()} disabled={busy || code.length < 4}>
              {busy ? "Проверяем…" : "Подтвердить"}
              {!busy && <ArrowRight className="h-4 w-4" />}
            </Button>
            <button
              type="button"
              onClick={() => { setStage("phone"); setCode(""); setError(null); setInfo(null); }}
              className="w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Изменить номер
            </button>
            {info && (
              <FormAlert variant="success" className="mt-1">
                {info}
              </FormAlert>
            )}
          </div>
        ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-foreground">
              Личный номер
            </label>
            <p className="mt-1 mb-1.5 text-xs text-muted-foreground">
              Это ваш личный номер, а не номер бизнес-WhatsApp.
            </p>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => {
                setPhone(formatPhoneInput(e.target.value));
                if (error) setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              placeholder={PHONE_HINT}
              aria-invalid={error ? true : undefined}
              className={cn(
                "mt-1.5 w-full rounded-lg border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground",
                error
                  ? "border-red-400 focus:border-red-500 focus:ring-1 focus:ring-red-500/20"
                  : "border-border focus:border-foreground focus:ring-1 focus:ring-foreground/10"
              )}
            />
            <p className="mt-1 text-xs text-muted-foreground">Формат +7XXXXXXXXXX (Казахстан / Россия)</p>
          </div>

          <Button
            className="w-full"
            onClick={() => void submit()}
            disabled={busy || !phone.trim()}
          >
            {busy ? "Проверяем…" : "Продолжить"}
            {!busy && <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
        )}

        {stage === "phone" && (
          <div className="mt-5 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-xs leading-5 text-muted-foreground">
            <div className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
              <Bell className="h-3.5 w-3.5" />
              Что мы будем сюда присылать
            </div>
            <ul className="space-y-1 pl-1">
              <li>• уведомления о новых лидах от бота;</li>
              <li>• статус подключения WhatsApp и важные алерты;</li>
              <li>• ничего рекламного, без спама.</li>
            </ul>
          </div>
        )}

        {error && (
          <FormAlert variant="error" className="mt-4">
            {error}
          </FormAlert>
        )}
      </div>
    </div>
  );
}
