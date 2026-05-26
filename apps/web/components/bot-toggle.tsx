"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { resetAuthStatus, subscribeAuthStatus } from "@/lib/use-auth-status";

type MeResponse = {
  success?: boolean;
  agent?: { id: string; botEnabled?: boolean } | null;
};

/**
 * Глобальный «выключатель» бота на уровне агента.
 *
 * Источник правды — `Agent.botEnabled` в БД, читаем через `/auth/me`, пишем
 * через `PATCH /agent/bot-state`. Подписываемся на изменения auth-status,
 * чтобы при логине/смене телефона состояние тоже подтянулось без F5.
 *
 * Семантика: при выключенном боте wa-pipeline возвращает `bot_paused` ещё до
 * сохранения inbound — сообщения клиента в этом окне НЕ попадают в историю и
 * НЕ списывают квоту, будто бота вообще нет.
 */
export function BotToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/auth/me", { method: "GET" });
      if (res.status === 401) {
        setEnabled(null);
        return;
      }
      const data = (await res.json()) as MeResponse;
      const next = data.agent?.botEnabled;
      setEnabled(typeof next === "boolean" ? next : null);
    } catch {
      setEnabled(null);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeAuthStatus(() => {
      void load();
    });
    return unsubscribe;
  }, [load]);

  async function toggle() {
    if (submitting || enabled === null) return;
    const next = !enabled;
    setSubmitting(true);
    // Оптимистично — UX заметно живее, при ошибке откатимся.
    const prev = enabled;
    setEnabled(next);
    try {
      const res = await apiFetch("/agent/bot-state", {
        method: "PATCH",
        body: JSON.stringify({ botEnabled: next })
      });
      if (!res.ok) {
        let message = "Не удалось обновить статус бота";
        try {
          const body = (await res.json()) as { message?: string };
          if (body?.message) message = body.message;
        } catch {
          // ignore
        }
        throw new Error(message);
      }
      const body = (await res.json()) as { botEnabled?: boolean };
      if (typeof body.botEnabled === "boolean") {
        setEnabled(body.botEnabled);
      }
      // Расшарим состояние с сайдбаром и др. подписчиками auth-status.
      resetAuthStatus();
      toast.success(next ? "Бот включён" : "Бот на паузе");
    } catch (err) {
      setEnabled(prev);
      toast.error(err instanceof Error ? err.message : "Не удалось обновить статус бота");
    } finally {
      setSubmitting(false);
    }
  }

  if (enabled === null) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
        <Bot className="h-3.5 w-3.5" />
        <span>Статус бота…</span>
      </div>
    );
  }

  const label = enabled ? "Бот отвечает" : "Бот на паузе";
  const Icon = enabled ? Pause : Play;
  const actionLabel = enabled ? "Поставить на паузу" : "Запустить бота";

  return (
    <div className="inline-flex items-center gap-2">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
          enabled
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-amber-200 bg-amber-50 text-amber-700"
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            enabled ? "bg-emerald-500" : "bg-amber-500"
          )}
        />
        {label}
      </span>
      <Button
        type="button"
        variant={enabled ? "outline" : "default"}
        size="sm"
        onClick={toggle}
        disabled={submitting}
      >
        {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
        {actionLabel}
      </Button>
    </div>
  );
}
