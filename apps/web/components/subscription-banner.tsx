"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

type UsageView = {
  remaining: number;
  exhausted: boolean;
  planLabel: string | null;
  daysLeft: number | null;
  warnExpiring: boolean;
  warnLowDialogs: boolean;
};

// Верхний баннер в кабинете: предупреждение об окончании тарифа / исчерпании
// диалогов. Закрывается на сессию (в памяти), но снова появится при перезагрузке,
// пока условие держится.
export default function SubscriptionBanner() {
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const res = await apiFetch("/billing/me", { method: "GET" });
        if (!res.ok) return;
        const data = (await res.json()) as { ok: boolean; usage?: UsageView };
        if (!stopped && data.ok && data.usage) setUsage(data.usage);
      } catch {
        /* non-critical */
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (!usage || dismissed) return null;
  const show = usage.exhausted || usage.warnExpiring || usage.warnLowDialogs;
  if (!show) return null;

  const text = usage.exhausted
    ? "Диалоги закончились, бот не отвечает клиентам. Продлите тариф или докупите диалоги."
    : usage.warnExpiring && usage.daysLeft !== null
    ? `Тариф${usage.planLabel ? ` «${usage.planLabel}»` : ""} заканчивается ${usage.daysLeft === 0 ? "сегодня" : `через ${usage.daysLeft} дн.`}, продлите, чтобы бот не остановился.`
    : `Осталось ${usage.remaining} диалогов, докупите, чтобы не прерывать работу бота.`;

  return (
    <div className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <Link
        href="/billing"
        className="shrink-0 rounded-full bg-amber-900 px-3 py-1 text-xs font-semibold text-amber-50 transition hover:bg-amber-800"
      >
        Перейти к тарифам
      </Link>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-amber-700 hover:text-amber-900"
        aria-label="Скрыть"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
