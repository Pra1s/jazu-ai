"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { apiFetch, apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type Plan = {
  id: "basic" | "pro" | "max" | "custom";
  label: string;
  description: string;
  conversations: number | null;
  pricePerOne: number;
  totalPrice: number | null;
  popular?: boolean;
};

type PlansResponse = {
  pricePerDialog: number;
  currency: string;
  freeTrialDialogs: number;
  plans: Plan[];
  custom: { min: number; max: number; step: number };
};

type UsageView = {
  total: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  trialActive: boolean;
  periodKey: string;
};

function fmt(n: number) {
  return n.toLocaleString("ru-RU");
}

export default function BillingClient() {
  const router = useRouter();
  const [data, setData] = useState<PlansResponse | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [me, setMe] = useState<{ ok: boolean } | null>(null);
  const [customCount, setCustomCount] = useState<number>(500);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const plans = await apiJson<PlansResponse>("/billing/plans");
        setData(plans);
        setCustomCount(Math.round((plans.custom.min + plans.custom.max) / 2));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Не удалось загрузить тарифы");
      }
      const meRes = await apiFetch("/auth/me");
      if (meRes.ok) {
        const meData = (await meRes.json()) as { success: boolean; usage?: UsageView };
        setMe({ ok: meData.success });
        if (meData.usage) setUsage(meData.usage);
      } else {
        setMe({ ok: false });
      }
    })();
  }, []);

  const customPrice = useMemo(() => {
    if (!data) return 0;
    return customCount * data.pricePerDialog;
  }, [customCount, data]);

  async function purchase(packageId: Plan["id"], custom?: number) {
    if (!me?.ok) {
      router.push("/auth");
      return;
    }
    setBusyPlan(packageId);
    setError(null);
    setSuccessMsg(null);
    try {
      const body: Record<string, unknown> = { packageId };
      if (packageId === "custom" && typeof custom === "number") {
        body.customCount = custom;
      }
      const res = await apiJson<{
        ok: boolean;
        error?: string;
        usage?: UsageView;
        purchase?: { conversations: number; amount: number };
      }>("/billing/purchase", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) {
        setError(res.error ?? "Ошибка оплаты");
        return;
      }
      if (res.usage) setUsage(res.usage);
      if (res.purchase) {
        setSuccessMsg(
          `+${fmt(res.purchase.conversations)} диалогов · ${fmt(res.purchase.amount)} ₸`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка оплаты");
    } finally {
      setBusyPlan(null);
    }
  }

  if (!data) {
    return (
      <div className="py-24 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
        Загружаем…
      </div>
    );
  }

  const fixed = data.plans.filter((p) => p.id !== "custom");

  return (
    <div className="space-y-12">
      {/* Баланс — одна строка, без рамок и прогресс-баров. */}
      {usage && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-6">
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              {fmt(usage.remaining)}
            </span>
            <span className="text-sm text-muted-foreground">
              из {fmt(usage.total)} диалогов осталось
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {usage.trialActive
              ? `Пробный период — ${fmt(data.freeTrialDialogs)} диалогов бесплатно`
              : `В этом месяце использовано: ${fmt(usage.used)}`}
          </div>
        </div>
      )}

      {/* Три фикс-тарифа. Популярный приподнят и в чёрной рамке. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fixed.map((plan) => (
          <PlanCard
            key={plan.id}
            label={plan.label}
            count={plan.conversations ?? 0}
            price={plan.totalPrice ?? 0}
            popular={Boolean(plan.popular)}
            busy={busyPlan === plan.id}
            onPurchase={() => void purchase(plan.id)}
          />
        ))}
      </div>

      {/* Custom — широкий блок. Цена и количество одного типографического
          веса (text-3xl). На десктопе — два столбца, на мобилке — центр-stack. */}
      <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <div className="grid gap-8 sm:grid-cols-[1fr_240px] sm:items-center sm:gap-10">
          {/* Слева: настройка */}
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Свой объём
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
                {fmt(customCount)}
              </span>
              <span className="text-sm text-muted-foreground">диалогов</span>
            </div>

            <div className="mt-5">
              <input
                type="range"
                min={data.custom.min}
                max={data.custom.max}
                step={data.custom.step}
                value={customCount}
                onChange={(e) => setCustomCount(Number(e.target.value))}
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary outline-none accent-foreground"
                aria-label="Количество диалогов"
              />
              <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                <span>{fmt(data.custom.min)}</span>
                <span>{fmt(data.custom.max)}</span>
              </div>
            </div>
          </div>

          {/* Справа: цена + CTA, на мобилке центрировано */}
          <div className="flex flex-col items-center gap-3 sm:items-end sm:border-l sm:border-border sm:pl-10">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Итого
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
                {fmt(customPrice)}
              </span>
              <span className="text-base text-muted-foreground">₸</span>
            </div>
            <div className="text-xs tabular-nums text-muted-foreground">
              по {fmt(data.pricePerDialog)} ₸ за диалог
            </div>
            <Button
              size="lg"
              className="mt-2 w-full sm:w-auto sm:min-w-[160px]"
              onClick={() => void purchase("custom", customCount)}
              disabled={busyPlan === "custom"}
            >
              {busyPlan === "custom" ? "Обрабатываем…" : "Купить"}
            </Button>
          </div>
        </div>
      </div>

      {/* Мелким — единая правда о цене, без отдельных «фичей». */}
      <p className="text-center text-xs text-muted-foreground">
        Фиксированная цена{" "}
        <span className="text-foreground">{fmt(data.pricePerDialog)} ₸</span> за 1 диалог
        для всех тарифов · без подписки · без скрытых платежей
      </p>

      {(error || successMsg) && (
        <div className="flex justify-center">
          {error && (
            <div className="rounded-full border border-red-200 bg-red-50 px-4 py-1.5 text-xs font-medium text-red-700">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="rounded-full bg-emerald-50 px-4 py-1.5 text-xs text-emerald-800">
              {successMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlanCard({
  label,
  count,
  price,
  popular,
  busy,
  onPurchase
}: {
  label: string;
  count: number;
  price: number;
  popular?: boolean;
  busy: boolean;
  onPurchase: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border bg-card p-7 sm:p-8 transition-colors",
        popular
          ? "border-foreground sm:-translate-y-1"
          : "border-border hover:border-foreground/30"
      )}
    >
      {popular && (
        <div className="absolute -top-2.5 left-7 rounded-full bg-foreground px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-background">
          Популярный
        </div>
      )}

      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>

      {/* Количество — крупно. Цена — чуть мельче, но всё ещё «несущая» строка,
          явно читаемая и на мобилке, и на десктопе. */}
      <div className="mt-5 flex items-baseline gap-2">
        <span className="text-4xl font-bold tracking-tight text-foreground tabular-nums sm:text-5xl">
          {fmt(count)}
        </span>
        <span className="text-sm text-muted-foreground">диалогов</span>
      </div>

      <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground sm:text-3xl">
        {fmt(price)} <span className="text-muted-foreground">₸</span>
      </div>

      <Button
        variant={popular ? "default" : "outline"}
        size="lg"
        className="mt-7 w-full rounded-full"
        onClick={onPurchase}
        disabled={busy}
      >
        {busy ? "Обрабатываем…" : "Купить"}
      </Button>
    </div>
  );
}
