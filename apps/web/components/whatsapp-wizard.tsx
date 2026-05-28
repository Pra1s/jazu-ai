"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, QrCode, Smartphone, RefreshCw, Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";
import { apiFetch, apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";

type WaStatusResponse = {
  agentId?: string | null;
  workerStatus?: {
    status: "disconnected" | "qr" | "pairing" | "connected" | "error";
    qrText?: string | null;
    qrDataUrl?: string | null;
    phone?: string | null;
    workerSessionId?: string | null;
    lastSeenAt?: string | null;
  };
  connection?: {
    status: "disconnected" | "qr" | "pairing" | "connected" | "error";
    qrText?: string | null;
    qrDataUrl?: string | null;
    phone?: string | null;
  } | null;
};

type Me = {
  success: boolean;
  user?: { phone?: string | null };
  needsPhone?: boolean;
};

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

export default function WhatsappWizard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<WaStatusResponse | null>(null);
  const [mode, setMode] = useState<"qr" | "code">("code");

  const [phone, setPhone] = useState("");
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [requestingCode, setRequestingCode] = useState(false);
  const [requestingQr, setRequestingQr] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const effectiveStatus =
    status?.workerStatus?.status ?? status?.connection?.status ?? "disconnected";
  const qrImage = useMemo(
    () => status?.workerStatus?.qrDataUrl || status?.connection?.qrDataUrl || null,
    [status]
  );
  const connectedPhone = status?.workerStatus?.phone || status?.connection?.phone || null;
  // Worker'у некуда было передать message ошибки, кроме qrText (поле String?).
  // На фронте если status=error, qrText трактуем как «человеческое сообщение».
  const errorMessage =
    status?.workerStatus?.qrText || status?.connection?.qrText || null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Аутентификация: /whatsapp требует логина.
      const res = await apiFetch("/auth/me", { method: "GET" });
      if (cancelled) return;
      if (res.status === 401) {
        setMe({ success: false });
        return;
      }
      const data = (await res.json()) as Me;
      setMe(data);
      if (data.user?.phone) {
        setPhone(formatPhoneInput(data.user.phone));
      }
      await refreshStatus();
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
     
  }, []);

  useEffect(() => {
    if (effectiveStatus === "connected") {
      stopPolling();
      return;
    }
    if (effectiveStatus === "qr" || effectiveStatus === "pairing") {
      startPolling();
    }
    return () => undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveStatus]);

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void refreshStatus();
    }, 2500);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function refreshStatus() {
    try {
      const res = await apiFetch("/whatsapp/status", { method: "GET" });
      if (res.status === 401) return;
      const data = (await res.json()) as WaStatusResponse;
      setStatus(data);
    } catch {
      // тихо — следующий poll попробует ещё раз
    }
  }

  async function requestQr() {
    setError(null);
    setRequestingQr(true);
    setPairCode(null);
    try {
      await apiJson("/whatsapp/qr", { method: "POST" });
      await refreshStatus();
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось открыть QR");
    } finally {
      setRequestingQr(false);
    }
  }

  /**
   * Запросить pairing code.
   *
   * Если в БД уже висит активная pairing/qr-сессия (например, юзер просил код,
   * не успел ввести, сессия осталась) — ОБЯЗАТЕЛЬНО сначала зовём
   * DELETE /whatsapp, чтобы worker полностью почистил authState. Иначе
   * WhatsApp отбивает и старый, и новый код как «неверный»: на стороне
   * сервера висит partial-сессия с предыдущей попытки.
   *
   * Идемпотентный кейс (тот же номер, код ещё в TTL) обрабатывает worker —
   * вернёт тот же код, что и в первый раз.
   */
  async function requestPairCode() {
    if (requestingCode) return;
    setError(null);
    if (!phone.trim()) {
      setError("Введите номер WhatsApp");
      return;
    }
    setRequestingCode(true);

    const needsReset =
      Boolean(pairCode) ||
      effectiveStatus === "pairing" ||
      effectiveStatus === "qr" ||
      effectiveStatus === "error";
    if (needsReset) {
      setPairCode(null);
      stopPolling();
      try {
        await apiFetch("/whatsapp", { method: "DELETE" });
      } catch {
        // не критично, дальше попробуем выдать код в любом случае
      }
      await refreshStatus();
    }

    try {
      const res = await apiFetch("/whatsapp/pair", {
        method: "POST",
        body: JSON.stringify({ phone: phone.trim() })
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: string;
        error?: string;
      };
      if (res.ok && data.ok && data.code) {
        setPairCode(data.code);
        await refreshStatus();
        startPolling();
        return;
      }
      setError(data.error ?? "Не удалось получить код. Попробуйте «Сбросить и заново».");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось получить код");
    } finally {
      setRequestingCode(false);
    }
  }

  // Кнопка «Сбросить и заново» — теперь просто алиас requestPairCode, потому
  // что он сам делает reset при необходимости. Оставляем явный wrapper
  // для UX: пользователь хочет понятную кнопку «начать с нуля».
  async function resetAndRetry() {
    await requestPairCode();
  }

  async function disconnect() {
    setDisconnecting(true);
    setError(null);
    stopPolling();
    try {
      // apiFetch вместо apiJson — раньше при 500 от worker'а apiJson бросал
      // throw и UI оставался в состоянии «Подключено». Сейчас бэк всегда
      // чистит локальный authState даже при worker_error, так что мы
      // можем смело продолжать — но всё равно покажем юзеру осмысленный
      // статус, если что-то пошло не так.
      const res = await apiFetch("/whatsapp", { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        workerError?: string;
      };
      if (!res.ok) {
        toast.error("Не удалось отключить WhatsApp. Попробуйте ещё раз.");
        return;
      }
      setPairCode(null);
      await refreshStatus();
      if (data.workerError) {
        toast.warning("WhatsApp отключён локально. Воркер недоступен — это не помешает переподключению.");
      } else {
        toast.success("WhatsApp отключён");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось отключить WhatsApp");
    } finally {
      setDisconnecting(false);
    }
  }

  // ── Loading
  if (me === null) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
        Загрузка…
      </div>
    );
  }

  // ── Гость: предлагаем залогиниться
  if (!me.success) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
          <LogIn className="h-5 w-5" />
        </div>
        <h2 className="text-lg font-semibold">Войдите в аккаунт</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Подключение WhatsApp требует входа — мы привяжем номер к вашему аккаунту.
        </p>
        <Button className="mt-4" onClick={() => router.push("/auth")}>
          Войти
        </Button>
      </div>
    );
  }

  // ── Ошибка: показываем сообщение и предлагаем сбросить.
  // Главный кейс — отказ wa-claim («этот номер уже привязан к другому
  // аккаунту»). qrText от worker'а несёт человекочитаемый текст.
  if (effectiveStatus === "error") {
    return (
      <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-8">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <LogIn className="h-6 w-6 rotate-180" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-destructive">Не удалось подключить WhatsApp</h2>
            <p className="mt-2 text-sm leading-6 text-foreground">
              {errorMessage ?? "Произошла ошибка при подключении. Попробуйте ещё раз."}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void disconnect()}
                disabled={disconnecting}
              >
                {disconnecting ? "Сбрасываем…" : "Сбросить и попробовать снова"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Подключено: показываем «Connected»
  if (effectiveStatus === "connected") {
    return (
      <div className="rounded-2xl border border-border bg-card p-8">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">WhatsApp подключён</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Бот отвечает клиентам с номера{" "}
              <span className="font-medium text-foreground">{connectedPhone ?? "—"}</span>.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void refreshStatus()}>
                <RefreshCw className="h-3.5 w-3.5" /> Обновить статус
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void disconnect()}
                disabled={disconnecting}
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
              >
                {disconnecting ? "Отключаем…" : "Отключить"}
              </Button>
            </div>
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
              <b>После «Отключить»:</b> на нашей стороне привязка снимается полностью.
              Чтобы убрать её и в WhatsApp на телефоне, откройте{" "}
              <b>Настройки → Связанные устройства</b>, выберите{" "}
              <b>app.jazu.chat</b> и нажмите <b>«Выйти»</b>. Иначе устройство останется
              в списке (без активной сессии).
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Основной экран с вкладками
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <Tabs value={mode} onValueChange={(v) => setMode(v as "qr" | "code")}>
          <TabsList className="!flex w-full">
            <TabsTrigger value="code" className="gap-2">
              <Smartphone className="h-4 w-4" />
              Код для телефона
            </TabsTrigger>
            <TabsTrigger value="qr" className="gap-2">
              <QrCode className="h-4 w-4" />
              QR-код
            </TabsTrigger>
          </TabsList>

          {/* ─── Code mode ──────────────────────────────────────────────── */}
          <TabsContent value="code" className="mt-6">
            <h2 className="text-base font-semibold">Подключение по коду</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Введите номер WhatsApp бизнеса. Мы выдадим 8-значный код, который нужно ввести
              в приложении.
            </p>

            <div className="mt-4">
              <label htmlFor="wa-phone" className="block text-sm font-medium">
                Номер WhatsApp
              </label>
              <input
                id="wa-phone"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && void requestPairCode()}
                placeholder="+7 701 123 45 67"
                disabled={requestingCode || Boolean(pairCode)}
                className={cn(
                  "mt-1.5 w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm outline-none transition placeholder:text-muted-foreground",
                  "focus:border-foreground focus:ring-1 focus:ring-foreground/10",
                  "disabled:opacity-60"
                )}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Формат +7XXXXXXXXXX (Казахстан / Россия)
              </p>
            </div>

            {!pairCode && (
              <Button
                className="mt-4 w-full sm:w-auto"
                onClick={() => void requestPairCode()}
                disabled={requestingCode || !phone.trim()}
              >
                {requestingCode ? "Получаем код…" : "Получить код"}
              </Button>
            )}

            {pairCode && (
              <div className="mt-6 space-y-4">
                <div className="rounded-2xl bg-emerald-50 px-6 py-8 text-center">
                  <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
                    Ваш код
                  </div>
                  <div className="mt-2 text-4xl font-mono font-semibold tracking-[0.3em] text-emerald-900 sm:text-5xl">
                    {pairCode}
                  </div>
                </div>

                <ol className="space-y-2 text-sm text-foreground">
                  <li className="flex gap-3">
                    <span className="font-mono text-muted-foreground">1.</span>
                    <span>Откройте <b>WhatsApp</b> на телефоне с номером {phone}.</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-muted-foreground">2.</span>
                    <span>
                      Перейдите в <b>Настройки → Связанные устройства → Привязка устройства</b>.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-mono text-muted-foreground">3.</span>
                    <span>Нажмите <b>«Связать по номеру телефона»</b> и введите код выше.</span>
                  </li>
                </ol>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPairCode(null);
                      setError(null);
                    }}
                  >
                    Изменить номер
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void resetAndRetry()}
                    disabled={requestingCode}
                  >
                    Сбросить и заново
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refreshStatus()}
                    className="gap-2"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Проверить статус
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Статус обновляется автоматически каждые 2.5 секунды. После успешной привязки
                  страница покажет «Подключено».
                </p>
              </div>
            )}
          </TabsContent>

          {/* ─── QR mode ───────────────────────────────────────────────── */}
          <TabsContent value="qr" className="mt-6">
            <h2 className="text-base font-semibold">Подключение по QR-коду</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Откройте WhatsApp → Настройки → Связанные устройства → Привязка устройства
              и отсканируйте QR ниже.
            </p>

            {!qrImage && (
              <Button
                className="mt-4 w-full sm:w-auto"
                onClick={() => void requestQr()}
                disabled={requestingQr}
              >
                {requestingQr ? "Открываем QR…" : "Показать QR-код"}
              </Button>
            )}

            {qrImage && (
              <div className="mt-6 flex flex-col items-center gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrImage}
                  alt="QR код для WhatsApp"
                  className="w-[260px] rounded-2xl border border-border bg-white p-3"
                />
                <p className="text-center text-xs text-muted-foreground">
                  QR обновляется каждые 2 секунды. Если истекает — просто отсканируйте снова.
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>

        {error && (
          <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>

      {/* Status footer (когда уже что-то начали, но ещё не подключено) */}
      {(effectiveStatus === "qr" || effectiveStatus === "pairing") && (
        <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">
              Ожидаем подключения{" "}
              {connectedPhone ? (
                <>
                  с номера <span className="font-medium text-foreground">{connectedPhone}</span>
                </>
              ) : null}
              …
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Если код не подошёл или WhatsApp пишет «неверный код» — нажмите{" "}
            <b className="text-foreground">«Сбросить и заново»</b>. Просто запросить новый код
            не поможет: WhatsApp удерживает старую сессию, нужно её сбросить.
          </p>
        </div>
      )}
    </div>
  );
}
