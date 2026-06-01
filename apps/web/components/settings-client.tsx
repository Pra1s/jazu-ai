"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, apiJson } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { resetAuthStatus } from "@/lib/use-auth-status";

// Фиче-флаги видимости разделов настроек. Код оставлен в файле, чтобы
// быстро вернуть, поставив true. Пока скрыто по запросу.
const SHOW_DANGER_ZONE = false; // секция «Опасная зона» / удаление аккаунта
const SHOW_WORKSPACE_TAB = false; // вкладка «Workspace»

type MeResponse = {
  success: boolean;
  user?: {
    id: string;
    email: string;
    name?: string | null;
    phone?: string | null;
    telegramChatId?: string | null;
  } | null;
  agent?: {
    id: string;
    name: string;
    status: string;
    currentPrompt?: string;
  } | null;
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  inputMode,
  invalid
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: "text" | "tel" | "numeric" | "email" | "url" | "search" | "decimal";
  invalid?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      inputMode={inputMode}
      aria-invalid={invalid ? true : undefined}
      className={cn(
        "w-full rounded-lg border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground",
        invalid
          ? "border-red-400 focus:border-red-500 focus:ring-1 focus:ring-red-500/20"
          : "border-border focus:border-foreground focus:ring-1 focus:ring-foreground/10"
      )}
    />
  );
}

export default function SettingsClient() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deleteWaAcknowledged, setDeleteWaAcknowledged] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function deleteAccount() {
    if (deleteBusy) return;
    if (!me?.user?.email) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const response = await apiFetch("/auth/me", {
        method: "DELETE",
        body: JSON.stringify({ confirmEmail: deleteConfirmEmail.trim() })
      });
      const data = (await response.json().catch(() => null)) as
        | { success?: boolean; message?: string }
        | null;
      if (!response.ok || !data?.success) {
        const message = data?.message ?? "Не удалось удалить аккаунт";
        setDeleteError(message);
        return;
      }
      // Аккаунт удалён. Сбрасываем глобальный auth-статус и редиректим
      // на /auth — там пользователь увидит чистую форму логина.
      resetAuthStatus();
      toast.success("Аккаунт удалён");
      router.replace("/auth");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось удалить аккаунт";
      setDeleteError(message);
    } finally {
      setDeleteBusy(false);
    }
  }

  const deleteCanSubmit =
    deleteAcknowledged &&
    deleteWaAcknowledged &&
    deleteConfirmEmail.trim().length > 0 &&
    !deleteBusy;

  useEffect(() => {
    apiJson<MeResponse>("/settings")
      .then((res) => {
        setMe(res);
        setTelegramChatId(res.user?.telegramChatId ?? "");
        setDisplayName(res.user?.name ?? "");
        setPhone(res.user?.phone ?? "");
      })
      .catch(() => toast.error("Не удалось загрузить профиль"));
  }, []);

  async function save() {
    setBusy(true);
    try {
      const res = await apiJson<MeResponse>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ telegramChatId, displayName })
      });
      setMe(res);
      toast.success("Настройки сохранены");
    } catch {
      toast.error("Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function savePhone() {
    if (!phone.trim() || phoneBusy) return;
    setPhoneBusy(true);
    setPhoneError(null);
    try {
      // apiFetch вместо apiJson: на 409 нужен ответный JSON с error,
      // а apiJson на не-2xx бросит исключение и сообщение пропадёт.
      const response = await apiFetch("/auth/phone", {
        method: "POST",
        body: JSON.stringify({ phone: phone.trim() })
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; phone?: string }
        | null;
      if (!response.ok || !data?.ok) {
        const message = data?.error ?? "Не удалось сохранить номер";
        setPhoneError(message);
        toast.error(message);
        // Конфликт по чужому номеру — сбрасываем поле, чтобы юзер ввёл
        // другой, а не пытался дожать тот же.
        if (response.status === 409) {
          setPhone("");
        }
        return;
      }
      setMe((prev) =>
        prev?.user
          ? { ...prev, user: { ...prev.user, phone: data.phone ?? phone.trim() } }
          : prev
      );
      setPhone(data.phone ?? phone.trim());
      resetAuthStatus();
      toast.success("Номер обновлён");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось сохранить номер";
      setPhoneError(message);
      toast.error(message);
    } finally {
      setPhoneBusy(false);
    }
  }

  const initialPhone = me?.user?.phone ?? "";
  const phoneDirty = phone.trim() !== initialPhone.trim();

  return (
    <div className="mx-auto max-w-2xl">
      <Tabs defaultValue="account">
        <TabsList>
          <TabsTrigger value="account">Аккаунт</TabsTrigger>
          <TabsTrigger value="notifications">Уведомления</TabsTrigger>
          {SHOW_WORKSPACE_TAB && <TabsTrigger value="workspace">Workspace</TabsTrigger>}
        </TabsList>

        {/* Account tab */}
        <TabsContent value="account">
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="text-sm font-semibold">Профиль</h2>
              <div className="mt-4 space-y-4">
                <div className="rounded-lg bg-secondary px-4 py-3 text-sm">
                  <div className="text-xs text-muted-foreground">Email</div>
                  <div className="mt-0.5 font-medium">{me?.user?.email ?? "Не авторизован"}</div>
                </div>
                <Field label="Имя">
                  <Input value={displayName} onChange={setDisplayName} placeholder="Иван" />
                </Field>
              </div>
              <div className="mt-5 flex gap-2">
                <Button onClick={() => void save()} disabled={busy}>
                  {busy ? "Сохраняю…" : "Сохранить"}
                </Button>
              </div>
            </div>

            {/* Опасная зона: удаление аккаунта. Скрыто фиче-флагом
                (SHOW_DANGER_ZONE) — пока не нужно, но код сохранён. */}
            {SHOW_DANGER_ZONE && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 sm:p-5">
                <h2 className="text-sm font-semibold text-red-700">Опасная зона</h2>
                <p className="mt-1.5 text-sm text-foreground">
                  Удаление аккаунта необратимо. Будут удалены: все агенты, подключения WhatsApp,
                  переписки, лиды и личные данные. История платежей сохраняется обезличенно
                  для бухгалтерии.
                </p>
                <div className="mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDeleteOpen(true);
                      setDeleteConfirmEmail("");
                      setDeleteAcknowledged(false);
                      setDeleteWaAcknowledged(false);
                      setDeleteError(null);
                    }}
                    className="border-red-300 bg-white text-red-700 hover:bg-red-100"
                  >
                    Удалить аккаунт
                  </Button>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Notifications tab */}
        <TabsContent value="notifications">
          <div className="space-y-4">
            {/* Основной канал: WhatsApp на личный номер. */}
            <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="text-sm font-semibold">Личный номер для уведомлений</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                На этот номер бот будет писать в WhatsApp о новых лидах. Если он
                совпадет с номером WhatsApp для AI бота, уведомления придут в чат
                «Сообщения себе». Формат +7XXXXXXXXXX (Казахстан / Россия).
              </p>
              {initialPhone && (
                <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                  Сохранён: {initialPhone}
                </div>
              )}
              <div className="mt-4">
                <Field label="Номер телефона">
                  <Input
                    value={phone}
                    onChange={(v) => {
                      setPhone(formatPhoneInput(v));
                      if (phoneError) setPhoneError(null);
                    }}
                    placeholder="+7 701 123 45 67"
                    type="tel"
                    inputMode="tel"
                    invalid={Boolean(phoneError)}
                  />
                </Field>
                {phoneError && (
                  <p className="mt-2 text-xs text-red-600">{phoneError}</p>
                )}
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  onClick={() => void savePhone()}
                  disabled={phoneBusy || !phone.trim() || !phoneDirty}
                >
                  {phoneBusy ? "Сохраняю…" : "Сохранить номер"}
                </Button>
              </div>
            </div>

            {/* Опциональный второй канал: Telegram. */}
            <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="text-sm font-semibold">Telegram (дополнительный канал)</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Лиды также можно получать в Telegram. Основной канал - WhatsApp;
                Telegram включается по желанию.
              </p>
              <div className="mt-4">
                <Field label="Telegram Chat ID">
                  <Input
                    value={telegramChatId}
                    onChange={setTelegramChatId}
                    placeholder="123456789"
                    type="text"
                  />
                </Field>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Узнать chat id: напишите @userinfobot в Telegram.
              </p>
              <div className="mt-4 flex gap-2">
                <Button onClick={() => void save()} disabled={busy}>
                  {busy ? "Сохраняю…" : "Сохранить"}
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* Workspace tab — скрыта фиче-флагом SHOW_WORKSPACE_TAB */}
        {SHOW_WORKSPACE_TAB && (
        <TabsContent value="workspace">
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Агент</h2>
            <div className="mt-4 space-y-2 text-sm">
              <div className="rounded-lg bg-secondary px-4 py-3">
                <div className="text-xs text-muted-foreground">Название</div>
                <div className="mt-0.5 font-medium">{me?.agent?.name ?? "Нет активного агента"}</div>
              </div>
              <div className="rounded-lg bg-secondary px-4 py-3">
                <div className="text-xs text-muted-foreground">Статус</div>
                <div className="mt-0.5">
                  <span className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium",
                    me?.agent?.status === "active"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-secondary text-muted-foreground"
                  )}>
                    {me?.agent?.status ?? "-"}
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" asChild>
                <a href="/whatsapp">WhatsApp</a>
              </Button>
              <Button variant="outline" asChild>
                <a href="/dashboard">Dashboard</a>
              </Button>
            </div>
          </div>
        </TabsContent>
        )}
      </Tabs>

      {deleteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => {
            if (!deleteBusy) setDeleteOpen(false);
          }}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-red-700">
              Удалить аккаунт навсегда?
            </h3>
            <p className="mt-2 text-sm text-foreground">
              Это действие нельзя отменить. Чтобы продолжить, отметьте оба пункта и
              введите свой email.
            </p>

            <div className="mt-5 space-y-3 text-sm">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={deleteAcknowledged}
                  onChange={(e) => setDeleteAcknowledged(e.target.checked)}
                  disabled={deleteBusy}
                  className="mt-0.5"
                />
                <span>
                  Я понимаю, что моя учётная запись, агенты, подключения WhatsApp,
                  переписки и лиды будут безвозвратно удалены.
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={deleteWaAcknowledged}
                  onChange={(e) => setDeleteWaAcknowledged(e.target.checked)}
                  disabled={deleteBusy}
                  className="mt-0.5"
                />
                <span>
                  Я понимаю, что WhatsApp-номера, которые я когда-либо привязывал,
                  нельзя будет привязать к другому моему аккаунту.
                </span>
              </label>
            </div>

            <div className="mt-5">
              <Field label={`Введите свой email для подтверждения: ${me?.user?.email ?? ""}`}>
                <Input
                  value={deleteConfirmEmail}
                  onChange={(v) => {
                    setDeleteConfirmEmail(v);
                    if (deleteError) setDeleteError(null);
                  }}
                  placeholder={me?.user?.email ?? ""}
                  type="email"
                  inputMode="email"
                  invalid={Boolean(deleteError)}
                />
              </Field>
              {deleteError && (
                <p className="mt-2 text-xs text-red-600">{deleteError}</p>
              )}
            </div>

            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteOpen(false)}
                disabled={deleteBusy}
              >
                Отмена
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void deleteAccount()}
                disabled={!deleteCanSubmit}
              >
                {deleteBusy ? "Удаляем…" : "Удалить аккаунт"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
