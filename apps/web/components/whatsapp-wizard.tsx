"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  QrCode,
  Smartphone,
  RefreshCw,
  Loader2,
  LogIn,
  MessageSquare,
  Settings,
  ArrowRight,
  Copy,
  HelpCircle,
  X
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch, apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { persistNext } from "@/lib/safe-next";
import { resetAuthStatus } from "@/lib/use-auth-status";

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
  const [helpOpen, setHelpOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Подтверждение личного номера для уведомлений ────────────────────────
  // Показывается на экране «WhatsApp подключён» ТОЛЬКО новому юзеру (у кого
  // ещё нет phone, me.needsPhone === true). Шаги: ask → input → code.
  //   ask   — «тот же ли номер, что у бота?» (Да → verify сразу / Нет → input)
  //   input — ввод личного номера, бэк шлёт код с номера бота
  //   code  — ввод 6-значного кода, который пришёл с номера бота
  // Переиспользуем /auth/phone/verify-start и /auth/phone/verify-confirm.
  const [notifStage, setNotifStage] = useState<"ask" | "input" | "code">("ask");
  const [notifPhone, setNotifPhone] = useState("");
  const [notifCode, setNotifCode] = useState("");
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);

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
   * Никакого reset с фронта НЕ делаем: `manager.pair()` на воркере сам
   * правильно разруливает все кейсы (идемпотентность по TTL, wipe authState
   * при повторе с другим номером, чистый старт). Если мы дополнительно
   * звали DELETE /whatsapp перед /whatsapp/pair, получался ДВОЙНОЙ stop:
   * worker рвал сокет, через 100ms стартовал новый, через ещё 100ms
   * запрашивал код — WhatsApp не успевал зачистить старую pairing-сессию,
   * новый код выпускался, но push-уведомления на телефон не приходили.
   *
   * Явный «начать с нуля» нужен только если юзер сам нажал
   * «Сбросить и заново» — это делает resetAndRetry().
   */
  async function requestPairCode() {
    if (requestingCode) return;
    setError(null);
    if (!phone.trim()) {
      setError("Введите номер WhatsApp");
      return;
    }
    setRequestingCode(true);

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

  // «Сбросить и заново» — явный полный reset: чистим authState через
  // DELETE /whatsapp, потом запрашиваем код заново. Используем только если
  // юзер реально хочет начать с чистого листа (например, прошлый код не
  // подошёл).
  async function resetAndRetry() {
    if (requestingCode) return;
    setError(null);
    setPairCode(null);
    stopPolling();
    setRequestingCode(true);
    try {
      try {
        await apiFetch("/whatsapp", { method: "DELETE" });
      } catch {
        // best-effort
      }
      await refreshStatus();
    } finally {
      setRequestingCode(false);
    }
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
        toast.warning("WhatsApp отключён локально. Воркер недоступен, это не помешает переподключению.");
      } else {
        toast.success("WhatsApp отключён");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось отключить WhatsApp");
    } finally {
      setDisconnecting(false);
    }
  }

  // verify-start: бэк сравнивает номер с номером бота. Если совпал — номер
  // считается подтверждённым сразу (verified). Если нет — шлёт код с номера
  // бота и переводит шаг в «code».
  async function startNotifVerify(targetPhone: string) {
    if (notifBusy) return;
    setNotifBusy(true);
    setNotifError(null);
    try {
      const res = await apiFetch("/auth/phone/verify-start", {
        method: "POST",
        body: JSON.stringify({ phone: targetPhone })
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; verified?: boolean; codeSent?: boolean }
        | null;
      if (!res.ok || !data?.ok) {
        setNotifError(data?.error ?? "Не удалось сохранить номер");
        return;
      }
      if (data.verified) {
        resetAuthStatus();
        router.replace("/dashboard");
        return;
      }
      setNotifStage("code");
    } catch (err) {
      setNotifError(err instanceof Error ? err.message : "Не удалось сохранить номер");
    } finally {
      setNotifBusy(false);
    }
  }

  function confirmSameNumber() {
    if (!connectedPhone) return;
    void startNotifVerify(connectedPhone);
  }

  function submitNotifPhone() {
    if (!notifPhone.trim()) return;
    void startNotifVerify(notifPhone.trim());
  }

  async function confirmNotifCode() {
    const trimmed = notifCode.replace(/\D+/g, "");
    if (!trimmed || notifBusy) return;
    setNotifBusy(true);
    setNotifError(null);
    try {
      const res = await apiFetch("/auth/phone/verify-confirm", {
        method: "POST",
        body: JSON.stringify({ code: trimmed })
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setNotifError(data?.error ?? "Неверный код");
        setNotifCode("");
        return;
      }
      resetAuthStatus();
      router.replace("/dashboard");
    } catch (err) {
      setNotifError(err instanceof Error ? err.message : "Не удалось проверить код");
    } finally {
      setNotifBusy(false);
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

  // ── Гость: ведём через быструю регистрацию, после неё вернём сюда же.
  if (!me.success) {
    const goRegister = () => {
      // Дублируем next в sessionStorage — переживёт Google-OAuth раундтрип,
      // где query-параметр теряется на стороне провайдера.
      persistNext("/whatsapp");
      router.push("/auth?next=/whatsapp");
    };
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
          <LogIn className="h-5 w-5" />
        </div>
        <h2 className="text-lg font-semibold">Ваш бот готов — остался один шаг</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Создайте бесплатный аккаунт за минуту, чтобы сохранить бота и
          подключить его к вашему WhatsApp. Все настройки и правки уже
          сохранены — сразу после входа вы вернётесь сюда, привяжете номер, и
          бот начнёт отвечать реальным клиентам.
        </p>
        <Button className="mt-4" onClick={goRegister}>
          Создать аккаунт и подключить
        </Button>
      </div>
    );
  }

  // ── Ошибка: показываем сообщение и предлагаем сбросить.
  // Главный кейс — отказ wa-claim («этот номер уже привязан к другому
  // аккаунту»). qrText от worker'а несёт человекочитаемый текст.
  if (effectiveStatus === "error") {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-8">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
            <LogIn className="h-6 w-6 rotate-180" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-red-700">Не удалось подключить WhatsApp</h2>
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
              <span className="font-medium text-foreground">{connectedPhone ?? "-"}</span>.
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
                className="border-red-300 text-red-600 hover:bg-red-50"
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

        {/* Новый юзер (ещё нет личного номера) — после подключения сначала
            подтверждает номер для уведомлений. Иначе — обычные подсказки. */}
        {me?.needsPhone === true ? (
          <div className="mt-6 border-t border-border pt-6">
            {notifStage === "ask" && (
              <>
                <h3 className="text-sm font-semibold text-foreground">
                  Куда присылать уведомления о лидах
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Присылать уведомления о новых лидах на этот же номер{" "}
                  <span className="font-medium text-foreground">{connectedPhone ?? "-"}</span>?
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={confirmSameNumber} disabled={notifBusy || !connectedPhone}>
                    {notifBusy ? "Сохраняем…" : "Да, на этот номер"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setNotifStage("input");
                      setNotifError(null);
                    }}
                    disabled={notifBusy}
                  >
                    Нет, другой номер
                  </Button>
                </div>
              </>
            )}

            {notifStage === "input" && (
              <>
                <h3 className="text-sm font-semibold text-foreground">
                  Личный номер для уведомлений
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  На этот номер будут приходить уведомления о новых лидах от бота.
                  Мы отправим код подтверждения с номера бота.
                </p>
                <div className="mt-4 max-w-sm">
                  <input
                    type="tel"
                    inputMode="tel"
                    value={notifPhone}
                    onChange={(e) => {
                      setNotifPhone(formatPhoneInput(e.target.value));
                      if (notifError) setNotifError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && submitNotifPhone()}
                    placeholder="+7 701 123 45 67"
                    className={cn(
                      "w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm outline-none transition placeholder:text-muted-foreground",
                      "focus:border-foreground focus:ring-1 focus:ring-foreground/10"
                    )}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Формат +7XXXXXXXXXX (Казахстан / Россия)
                  </p>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={submitNotifPhone} disabled={notifBusy || !notifPhone.trim()}>
                    {notifBusy ? "Отправляем код…" : "Получить код"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setNotifStage("ask");
                      setNotifError(null);
                    }}
                    disabled={notifBusy}
                  >
                    Назад
                  </Button>
                </div>
              </>
            )}

            {notifStage === "code" && (
              <>
                <h3 className="text-sm font-semibold text-foreground">Подтвердите номер</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Код пришёл с номера бота на{" "}
                  <span className="font-medium text-foreground">{notifPhone}</span>. Введите 6 цифр.
                </p>
                <div className="mt-4 max-w-sm">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={notifCode}
                    onChange={(e) => {
                      setNotifCode(e.target.value.replace(/\D+/g, "").slice(0, 6));
                      if (notifError) setNotifError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && void confirmNotifCode()}
                    placeholder="123456"
                    className={cn(
                      "w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-center text-lg font-mono tracking-[0.4em] text-foreground outline-none transition placeholder:text-muted-foreground/50",
                      "focus:border-foreground focus:ring-1 focus:ring-foreground/10"
                    )}
                  />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    onClick={() => void confirmNotifCode()}
                    disabled={notifBusy || notifCode.length < 4}
                  >
                    {notifBusy ? "Проверяем…" : "Подтвердить"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setNotifStage("input");
                      setNotifCode("");
                      setNotifError(null);
                    }}
                    disabled={notifBusy}
                  >
                    Изменить номер
                  </Button>
                </div>
              </>
            )}

            {notifError && (
              <FormAlert variant="error" className="mt-4">
                {notifError}
              </FormAlert>
            )}
          </div>
        ) : (
        /* Что дальше — подсказки после успешного подключения */
        <div className="mt-6 border-t border-border pt-6">
          <h3 className="text-sm font-semibold text-foreground">Что дальше</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Бот уже на связи. Вот куда заглянуть дальше.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Link
              href="/chats"
              className="group flex items-start gap-3 rounded-xl border border-border bg-background p-4 transition-colors hover:bg-secondary"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                <MessageSquare className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-sm font-medium text-foreground">
                  Диалоги
                  <ArrowRight className="h-3.5 w-3.5 -translate-x-0.5 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
                </div>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  Смотрите переписки клиентов с ботом и горячие лиды.
                </p>
              </div>
            </Link>

            <Link
              href="/settings"
              className="group flex items-start gap-3 rounded-xl border border-border bg-background p-4 transition-colors hover:bg-secondary"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                <Settings className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-sm font-medium text-foreground">
                  Настройки
                  <ArrowRight className="h-3.5 w-3.5 -translate-x-0.5 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
                </div>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  Подключите Telegram, чтобы получать уведомления о лидах.
                </p>
              </div>
            </Link>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Бот можно временно поставить на паузу в разделе{" "}
            <Link href="/chats" className="font-medium text-foreground underline-offset-2 hover:underline">
              «Диалоги»
            </Link>
            , он перестанет отвечать, пока вы не включите его снова.
          </p>
        </div>
        )}
      </div>
    );
  }

  // ── Основной экран с вкладками
  return (
    <div className="space-y-6">
      <div className="relative rounded-2xl border border-border bg-card p-6 sm:p-8">
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          aria-label="Помощь с подключением"
          title="Как подключить WhatsApp"
        >
          <HelpCircle className="h-5 w-5" />
        </button>
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
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(pairCode.replace(/\s+/g, ""));
                      toast.success("Код скопирован");
                    }}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-100"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Скопировать код
                  </button>
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
                  QR обновляется каждые 2 секунды. Если истекает, просто отсканируйте снова.
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>

        {error && (
          <FormAlert variant="error" className="mt-4">
            {error}
          </FormAlert>
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
            Если код не подошёл или WhatsApp пишет «неверный код», нажмите{" "}
            <b className="text-foreground">«Сбросить и заново»</b>. Просто запросить новый код
            не поможет: WhatsApp удерживает старую сессию, нужно её сбросить.
          </p>
        </div>
      )}

      {/* Модалка помощи: мануал-скринкаст сверху, кнопка хелпдеска снизу */}
      {helpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
            onClick={() => setHelpOpen(false)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl">
            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </button>
            <h2 className="text-base font-semibold text-foreground">Как подключить WhatsApp</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Короткое видео покажет все шаги подключения по коду или QR.
            </p>

            <div className="mt-4 flex aspect-video w-full items-center justify-center rounded-xl border border-border bg-secondary/50 text-sm text-muted-foreground">
              {/* TODO: заменить на встроенный скринкаст (видео/iframe) */}
              <div className="flex flex-col items-center gap-2">
                <QrCode className="h-8 w-8 opacity-50" />
                Скринкаст скоро появится здесь
              </div>
            </div>

            <a
              href="https://wa.me/77000000000"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#1ebe5c]"
            >
              <MessageSquare className="h-4 w-4" />
              Написать в поддержку
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
