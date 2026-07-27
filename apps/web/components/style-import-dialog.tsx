"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Upload, MessageSquare, Trash2, Loader2 } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { toast } from "sonner";

type StyleImportDialogProps = {
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
};

type StyleStatus = {
  status: "none" | "pending" | "queued" | "analyzing" | "aggregating" | "done" | "error";
  stage?: string;
  totalEpisodes?: number;
  processedEpisodes?: number;
  error?: string | null;
  hasStyle?: boolean;
  styleGuidePreview?: string | null;
};

type HistoryChat = {
  waChatId: string;
  label: string;
  messageCount: number;
  selected: boolean;
  lastMessageAt?: string | null;
};

type HistorySyncStatus = "idle" | "syncing" | "done";

type HistoryInfo = {
  chats: HistoryChat[];
  capture: boolean;
  syncStatus: HistorySyncStatus;
  progress: number;
  connected: boolean;
  syncStalled?: boolean;
};

type Tab = "files" | "whatsapp";

const IN_PROGRESS = new Set(["queued", "analyzing", "aggregating"]);

/** Читаемое имя чата: сохранённое имя/номер → номер из PN-JID → «Чат …1234».
 * Никогда не показываем сырой @lid (это не номер, а внутренний id WhatsApp). */
function chatDisplayName(c: HistoryChat): string {
  if (c.label && c.label.trim()) return c.label.trim();
  const at = c.waChatId.indexOf("@");
  const user = at > 0 ? c.waChatId.slice(0, at) : c.waChatId;
  const domain = at > 0 ? c.waChatId.slice(at + 1) : "";
  if (domain === "s.whatsapp.net" && /^\d{7,15}$/.test(user)) return `+${user}`;
  const digits = user.replace(/\D/g, "");
  return digits.length >= 4 ? `Чат …${digits.slice(-4)}` : "Без имени";
}

export default function StyleImportDialog({ open, onClose, onApplied }: StyleImportDialogProps) {
  const [tab, setTab] = useState<Tab>("files");
  const [ownerName, setOwnerName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StyleStatus | null>(null);
  const [historyChats, setHistoryChats] = useState<HistoryChat[]>([]);
  const [historyInfo, setHistoryInfo] = useState<HistoryInfo | null>(null);
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());
  // Дозагрузка вместо пересборки с нуля. Показывается, только когда стиль уже есть;
  // по умолчанию включена — «докинуть переписок» ожидаемее, чем стереть накопленное.
  const [appendMode, setAppendMode] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const historyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await apiJson<StyleStatus>("/agent/style-status");
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const data = await apiJson<HistoryInfo>("/agent/style-history-chats");
      setHistoryChats(data.chats);
      setHistoryInfo(data);
      return data;
    } catch {
      setHistoryChats([]);
      setHistoryInfo(null);
      return null;
    }
  }, []);

  // При открытии — тянем статус анализа и состояние захвата истории.
  useEffect(() => {
    if (!open) return;
    void refreshStatus();
    void refreshHistory();
  }, [open, refreshStatus, refreshHistory]);

  // Поллинг подтягивания истории из WhatsApp, пока синк идёт.
  useEffect(() => {
    const syncing = historyInfo?.syncStatus === "syncing";
    if (open && tab === "whatsapp" && syncing && !historyPollRef.current) {
      historyPollRef.current = setInterval(() => {
        void refreshHistory();
      }, 3000);
    }
    return () => {
      if (historyPollRef.current) {
        clearInterval(historyPollRef.current);
        historyPollRef.current = null;
      }
    };
  }, [open, tab, historyInfo?.syncStatus, refreshHistory]);

  // Поллинг прогресса, пока анализ идёт.
  useEffect(() => {
    const running = status && IN_PROGRESS.has(status.status);
    if (open && running && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void refreshStatus().then((s) => {
          if (s && !IN_PROGRESS.has(s.status) && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            if (s.status === "done" && s.hasStyle) {
              toast.success("Стиль применён — бот теперь отвечает в вашей манере");
              onApplied?.();
            } else if (s.status === "error") {
              toast.error(s.error || "Не удалось собрать стиль");
            }
          }
        });
      }, 3000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [open, status, refreshStatus, onApplied]);

  async function uploadFiles() {
    if (files.length === 0) {
      toast.error("Выберите файлы экспорта");
      return;
    }
    setBusy(true);
    try {
      const payloadFiles = await Promise.all(
        files.map(async (f) => ({ filename: f.name, content: await f.text() }))
      );
      const res = await apiJson<{ ok: boolean; totalEpisodes: number }>("/agent/style-dialogues", {
        method: "POST",
        body: JSON.stringify({
          ownerName: ownerName.trim() || undefined,
          files: payloadFiles,
          append: Boolean(status?.hasStyle) && appendMode
        })
      });
      toast.success(`Загружено, эпизодов: ${res.totalEpisodes}. Анализирую…`);
      setFiles([]);
      await refreshStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось загрузить");
    } finally {
      setBusy(false);
    }
  }

  async function enableCapture() {
    setBusy(true);
    try {
      await apiJson("/agent/style-history-enable", { method: "POST" });
      toast.success("Подтягиваю историю из WhatsApp…");
      await refreshHistory();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось включить сбор");
    } finally {
      setBusy(false);
    }
  }

  async function disableCapture() {
    setBusy(true);
    try {
      await apiJson("/agent/style-history-disable", { method: "POST" });
      setSelectedChats(new Set());
      toast.success("Сбор истории выключен");
      await refreshHistory();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось выключить сбор");
    } finally {
      setBusy(false);
    }
  }

  // Быстрый выбор N самых свежих чатов (список приходит уже отсортированным по
  // lastMessageAt desc), исключая пустые. Заменяет текущее выделение.
  function selectRecent(n: number) {
    const ids = historyChats
      .filter((c) => c.messageCount >= 4)
      .slice(0, Math.max(0, n))
      .map((c) => c.waChatId);
    setSelectedChats(new Set(ids));
  }

  async function analyzeSelected() {
    if (selectedChats.size === 0) {
      toast.error("Отметьте хотя бы один чат");
      return;
    }
    setBusy(true);
    try {
      const res = await apiJson<{ ok: boolean; totalEpisodes: number }>("/agent/style-history-analyze", {
        method: "POST",
        body: JSON.stringify({
          waChatIds: Array.from(selectedChats),
          append: Boolean(status?.hasStyle) && appendMode
        })
      });
      toast.success(`Отобрано эпизодов: ${res.totalEpisodes}. Анализирую…`);
      setHistoryChats([]);
      setSelectedChats(new Set());
      await refreshStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось запустить анализ");
    } finally {
      setBusy(false);
    }
  }

  async function resetStyle() {
    setBusy(true);
    try {
      await apiJson("/agent/style", { method: "DELETE" });
      toast.success("Стиль сброшен — бот вернулся к базовому поведению");
      await refreshStatus();
      onApplied?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сбросить");
    } finally {
      setBusy(false);
    }
  }

  const running = status && IN_PROGRESS.has(status.status);
  const hasStyle = status?.hasStyle;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            Бот в вашем стиле
          </DialogTitle>
          <DialogDescription>
            Загрузите переписки — бот проанализирует, как вы общаетесь с клиентами, и будет отвечать в вашей манере.
            Цены и факты бот всегда берёт из данных о бизнесе, а не из переписок.
          </DialogDescription>
        </DialogHeader>

        {/* Прогресс анализа */}
        {running && (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/30 p-4">
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand" />
            <div className="text-sm">
              <div className="font-medium text-foreground">Анализирую диалоги…</div>
              <div className="text-muted-foreground">
                {status?.status === "aggregating"
                  ? "Собираю паспорт стиля"
                  : status?.processedEpisodes !== undefined && status?.totalEpisodes
                    ? `Обработано ${status.processedEpisodes} из ${status.totalEpisodes}`
                    : "Готовлю диалоги"}
              </div>
            </div>
          </div>
        )}

        {/* Стиль применён */}
        {!running && hasStyle && (
          <div className="space-y-3 rounded-xl border border-brand/30 bg-brand/5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Sparkles className="h-4 w-4 text-brand" />
              Стиль применён
            </div>
            {status?.styleGuidePreview && (
              <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                {status.styleGuidePreview}
                {status.styleGuidePreview.length >= 590 ? "…" : ""}
              </p>
            )}
            <Button variant="outline" size="sm" onClick={() => void resetStyle()} disabled={busy}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Сбросить стиль
            </Button>
          </div>
        )}

        {/* Ошибка */}
        {!running && status?.status === "error" && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {status.error || "Не удалось собрать стиль. Попробуйте загрузить больше диалогов."}
          </div>
        )}

        {/* Источники (скрыты во время анализа) */}
        {!running && (
          <>
            <div className="flex gap-1 rounded-lg bg-secondary/50 p-1">
              <button
                type="button"
                onClick={() => setTab("files")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
                  tab === "files" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                )}
              >
                <Upload className="h-3.5 w-3.5" />
                Загрузить файлы
              </button>
              <button
                type="button"
                onClick={() => setTab("whatsapp")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
                  tab === "whatsapp" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                )}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Из WhatsApp
              </button>
            </div>

            {/* Стиль уже собран — даём выбрать: докинуть переписок или пересобрать с нуля */}
            {hasStyle && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-secondary/30 p-3">
                <input
                  type="checkbox"
                  checked={appendMode}
                  onChange={(e) => setAppendMode(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    Дополнить текущий стиль
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {appendMode
                      ? "Новые переписки добавятся к уже разобранным — накопленный стиль сохранится, повторно загруженные диалоги пропустятся."
                      : "Стиль соберётся заново: прежние разобранные диалоги удалятся, останутся только те, что загружаете сейчас."}
                  </span>
                </span>
              </label>
            )}

            {tab === "files" && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-foreground">
                    Как вы подписаны в чатах
                  </label>
                  <input
                    type="text"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder="Например: Ильяс (имя контакта на телефоне)"
                    className={cn(
                      "mt-1.5 w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground",
                      "focus:border-foreground focus:ring-1 focus:ring-foreground/10"
                    )}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Нужно для .txt-экспорта, чтобы отличить ваши реплики от клиентских. Для JSON-выгрузки не обязательно.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground">Файлы диалогов</label>
                  <input
                    type="file"
                    multiple
                    accept=".txt,.json"
                    onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                    className="mt-1.5 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-secondary/70"
                  />
                  {files.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">Выбрано файлов: {files.length}</p>
                  )}
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    На телефоне откройте чат → «Ещё» → «Экспорт чата» → «Без медиа». Файлы .txt можно
                    выбрать сразу несколько. Для массовой выгрузки подойдёт JSON от wtsexporter.
                  </p>
                </div>

                <div className="flex justify-end">
                  <Button onClick={() => void uploadFiles()} disabled={busy || files.length === 0}>
                    {busy ? "Загружаю…" : "Проанализировать"}
                  </Button>
                </div>
              </div>
            )}

            {tab === "whatsapp" && (
              <div className="space-y-3">
                {/* Нет подключённого WhatsApp — включать нечего */}
                {historyInfo && !historyInfo.connected && !historyInfo.capture && (
                  <p className="rounded-xl border border-border bg-secondary/30 p-4 text-xs leading-5 text-muted-foreground">
                    Сначала подключите WhatsApp на вкладке подключения номера. После этого здесь можно
                    будет одним нажатием подтянуть историю переписок для анализа стиля. Пока номер не
                    подключён — воспользуйтесь загрузкой файлов.
                  </p>
                )}

                {/* Согласие ещё не дано — показываем объяснение и кнопку */}
                {historyInfo && historyInfo.connected && !historyInfo.capture && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-border bg-secondary/30 p-4 text-xs leading-5 text-muted-foreground">
                      Мы можем подтянуть ваши переписки из WhatsApp и по ним собрать ваш стиль общения.
                      Переписки обрабатываются только для анализа стиля, телефоны маскируются, а цены и
                      факты бот всегда берёт из данных о бизнесе.
                      <br />
                      <br />
                      Важно: WhatsApp отдаёт историю только при <b>первичной привязке</b> номера. Если
                      номер уже подключён, для загрузки истории его нужно <b>переподключить заново</b>
                      (отвязать в WhatsApp → «Связанные устройства» и отсканировать QR снова). Если
                      переподключать не хочется — просто загрузите файлы экспорта на соседней вкладке.
                    </div>
                    <div className="flex justify-end">
                      <Button onClick={() => void enableCapture()} disabled={busy}>
                        <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                        {busy ? "Включаю…" : "Включить сбор истории"}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Синк завис — WhatsApp не прислал историю (скорее всего номер уже был привязан) */}
                {historyInfo && historyInfo.capture && historyInfo.syncStatus === "syncing" && historyInfo.syncStalled && (
                  <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                    <div className="text-sm font-medium text-foreground">
                      WhatsApp не прислал историю
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Так бывает, когда номер уже был привязан раньше — WhatsApp отдаёт переписку только
                      при новой привязке. Варианты: переподключите номер заново (отвяжите устройство в
                      WhatsApp и отсканируйте QR) — тогда история подтянется сюда автоматически, либо
                      загрузите файлы экспорта.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => setTab("files")} disabled={busy}>
                        <Upload className="mr-1.5 h-3.5 w-3.5" />
                        Загрузить файлы
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void disableCapture()} disabled={busy}>
                        Остановить
                      </Button>
                    </div>
                  </div>
                )}

                {/* Идёт подтягивание — статус-бар прогресса */}
                {historyInfo && historyInfo.capture && historyInfo.syncStatus === "syncing" && !historyInfo.syncStalled && (
                  <div className="space-y-2 rounded-xl border border-border bg-secondary/30 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-brand" />
                      Подтягиваю историю из WhatsApp…
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-brand transition-all duration-500"
                        style={{ width: `${Math.max(5, Math.min(100, historyInfo.progress))}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {historyInfo.progress > 0 ? `${historyInfo.progress}%` : "Ожидаю данные от WhatsApp"}
                      </span>
                      <span>Найдено чатов: {historyChats.length}</span>
                    </div>
                  </div>
                )}

                {/* Захват включён и есть чаты — выбор для анализа */}
                {historyInfo && historyInfo.capture && historyInfo.syncStatus !== "syncing" && (
                  <>
                    {historyChats.length === 0 ? (
                      <p className="rounded-xl border border-border bg-secondary/30 p-4 text-xs leading-5 text-muted-foreground">
                        Сбор включён, но подходящих личных чатов пока не пришло. WhatsApp присылает
                        историю не сразу и не всегда полностью. Можно подождать, переподключить номер
                        или воспользоваться загрузкой файлов.
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">
                            Отметьте клиентские чаты (исключите личные и семейные) — по ним соберём ваш стиль.
                          </p>
                          <button
                            type="button"
                            onClick={() => void disableCapture()}
                            disabled={busy}
                            className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
                          >
                            Выключить сбор
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">Быстрый выбор:</span>
                          <button
                            type="button"
                            onClick={() => selectRecent(historyChats.length)}
                            className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition hover:bg-secondary/50"
                          >
                            Все
                          </button>
                          {[20, 50, 100].map((n) =>
                            historyChats.length > n ? (
                              <button
                                key={n}
                                type="button"
                                onClick={() => selectRecent(n)}
                                className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition hover:bg-secondary/50"
                              >
                                Последние {n}
                              </button>
                            ) : null
                          )}
                          {selectedChats.size > 0 ? (
                            <button
                              type="button"
                              onClick={() => setSelectedChats(new Set())}
                              className="rounded-full px-2.5 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                            >
                              Снять все
                            </button>
                          ) : null}
                        </div>
                        <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-border p-1.5">
                          {historyChats.map((c) => {
                            const checked = selectedChats.has(c.waChatId);
                            return (
                              <label
                                key={c.waChatId}
                                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-secondary/50"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    setSelectedChats((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(c.waChatId);
                                      else next.delete(c.waChatId);
                                      return next;
                                    });
                                  }}
                                  className="h-4 w-4 shrink-0"
                                />
                                <span className="min-w-0 flex-1 truncate text-foreground">
                                  {chatDisplayName(c)}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">{c.messageCount}</span>
                              </label>
                            );
                          })}
                        </div>
                        <div className="flex justify-end">
                          <Button onClick={() => void analyzeSelected()} disabled={busy || selectedChats.size === 0}>
                            {busy ? "Запускаю…" : `Проанализировать (${selectedChats.size})`}
                          </Button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
