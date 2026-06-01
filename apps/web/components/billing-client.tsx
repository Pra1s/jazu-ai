"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check } from "lucide-react";
import { apiFetch, apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type Plan = {
  id: string;
  label: string;
  description: string;
  audience?: string;
  conversations: number | null;
  monthlyPriceKzt: number | null;
  pricePerDialogKzt: number;
  pricePerDialogUsdCents: number;
  kind: "subscription" | "enterprise";
  popular?: boolean;
  features?: string[];
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
  planId: string | null;
  planLabel: string | null;
  subscriptionEndsAt: string | null;
  daysLeft: number | null;
  warnExpiring: boolean;
  warnLowDialogs: boolean;
};

function fmt(n: number) {
  return n.toLocaleString("ru-RU");
}

// Платёжная ссылка Kaspi Pay. Пока единая для всех тарифов и докупки:
// после оплаты диалоги/тариф зачисляются вручную.
const KASPI_PAY_URL = "https://pay.kaspi.kz/pay/ugtxcmxz";

export default function BillingClient() {
  const router = useRouter();
  const [data, setData] = useState<PlansResponse | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [me, setMe] = useState<{ ok: boolean } | null>(null);
  const [topupCount, setTopupCount] = useState<number>(100);

  useEffect(() => {
    void (async () => {
      try {
        const plans = await apiJson<PlansResponse>("/billing/plans");
        setData(plans);
        setTopupCount(Math.max(plans.custom.min, 100));
      } catch {
        // тарифы не загрузились — покажем «Загружаем…», пользователь обновит
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

  // Цена докупки = по цене текущего тарифа пользователя.
  const currentPlan = useMemo(
    () => data?.plans.find((p) => p.id === usage?.planId) ?? null,
    [data, usage]
  );
  const topupPricePerDialog = currentPlan?.pricePerDialogKzt ?? data?.pricePerDialog ?? 0;
  const topupPrice = topupCount * topupPricePerDialog;

  // Оплата идёт через Kaspi Pay: открываем платёжную ссылку в новой вкладке.
  // Зачисление диалогов/тарифа происходит вручную после оплаты.
  function openKaspiPay() {
    if (!me?.ok) {
      router.push("/auth");
      return;
    }
    window.open(KASPI_PAY_URL, "_blank", "noopener,noreferrer");
  }

  if (!data) {
    return (
      <div className="py-24 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
        Загружаем…
      </div>
    );
  }

  const subscriptionPlans = data.plans.filter((p) => p.kind === "subscription");
  const enterprise = data.plans.find((p) => p.id === "enterprise");
  const hasPlan = Boolean(usage?.planId);

  return (
    <div className="space-y-12">
      {/* Баланс + статус подписки */}
      {usage && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-6">
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              {fmt(usage.remaining)}
            </span>
            <span className="text-sm text-muted-foreground">из {fmt(usage.total)} диалогов осталось</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {usage.planLabel
              ? `Тариф «${usage.planLabel}»${usage.daysLeft !== null ? ` · ${usage.daysLeft} дн. до конца` : ""}`
              : usage.trialActive
              ? `Пробный период - ${fmt(data.freeTrialDialogs)} диалогов бесплатно`
              : `Использовано: ${fmt(usage.used)}`}
          </div>
        </div>
      )}

      {/* Предупреждения */}
      {usage && (usage.warnExpiring || usage.warnLowDialogs) && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {usage.warnExpiring && usage.daysLeft !== null && (
            <p>Тариф заканчивается через {usage.daysLeft} дн. Продлите, чтобы бот не остановился.</p>
          )}
          {usage.warnLowDialogs && (
            <p>Осталось {fmt(usage.remaining)} диалогов. Докупите ниже, чтобы не прерывать работу бота.</p>
          )}
        </div>
      )}

      {/* Тарифы-подписки */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {subscriptionPlans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            current={usage?.planId === plan.id}
            onSubscribe={openKaspiPay}
          />
        ))}
      </div>

      {/* Enterprise — заявка, без оплаты и ползунка */}
      {enterprise && (
        <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {enterprise.label}
              </div>
              <div className="mt-2 text-2xl font-semibold text-foreground">Индивидуально</div>
              <p className="mt-1 text-sm text-muted-foreground">{enterprise.description}</p>
              {enterprise.features && (
                <ul className="mt-3 space-y-1.5">
                  {enterprise.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-foreground">
                      <Check className="h-3.5 w-3.5 text-[#25D366]" />
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <a
              href="https://wa.me/77000000000"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition hover:bg-foreground/90"
            >
              Оставить заявку
            </a>
          </div>
        </div>
      )}

      {/* Докупка диалогов — только при активном тарифе */}
      {hasPlan && (
        <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <div className="grid gap-8 sm:grid-cols-[1fr_240px] sm:items-center sm:gap-10">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Докупить диалоги
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                По цене вашего тарифа - {fmt(topupPricePerDialog)} ₸ за диалог.
              </p>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
                  {fmt(topupCount)}
                </span>
                <span className="text-sm text-muted-foreground">диалогов</span>
              </div>
              <div className="mt-5">
                <input
                  type="range"
                  min={data.custom.min}
                  max={data.custom.max}
                  step={data.custom.step}
                  value={topupCount}
                  onChange={(e) => setTopupCount(Number(e.target.value))}
                  className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary outline-none accent-foreground"
                  aria-label="Количество диалогов"
                />
                <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                  <span>{fmt(data.custom.min)}</span>
                  <span>{fmt(data.custom.max)}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-center gap-3 sm:items-end sm:border-l sm:border-border sm:pl-10">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Итого
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
                  {fmt(topupPrice)}
                </span>
                <span className="text-base text-muted-foreground">₸</span>
              </div>
              <Button
                size="lg"
                className="mt-2 w-full sm:w-auto sm:min-w-[160px]"
                onClick={openKaspiPay}
              >
                Докупить
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  current,
  onSubscribe
}: {
  plan: Plan;
  current: boolean;
  onSubscribe: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border bg-card p-7 sm:p-8 transition-colors",
        plan.popular ? "border-foreground sm:-translate-y-1" : "border-border hover:border-foreground/30"
      )}
    >
      {plan.popular && (
        <div className="absolute -top-2.5 left-7 rounded-full bg-foreground px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-background">
          Хит продаж
        </div>
      )}

      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {plan.label}
      </div>

      <div className="mt-5 flex items-baseline gap-2">
        <span className="text-3xl font-bold tracking-tight text-foreground tabular-nums sm:text-4xl">
          {fmt(plan.monthlyPriceKzt ?? 0)}
        </span>
        <span className="text-sm text-muted-foreground">₸ / мес</span>
      </div>

      <div className="mt-2 text-sm text-foreground">
        {fmt(plan.conversations ?? 0)} диалогов
        <span className="text-muted-foreground"> · ~{fmt(plan.pricePerDialogKzt)} ₸ за диалог</span>
      </div>

      {plan.audience && <p className="mt-1 text-xs text-muted-foreground">{plan.description}</p>}

      <Button
        variant={plan.popular ? "default" : "outline"}
        size="lg"
        className="mt-7 w-full rounded-full"
        onClick={onSubscribe}
        disabled={current}
      >
        {current ? "Текущий тариф" : "Подключить"}
      </Button>
    </div>
  );
}
