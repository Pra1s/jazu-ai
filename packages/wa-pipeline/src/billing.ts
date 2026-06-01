import type { prisma as Prisma } from "@jazu/db";

type PrismaClient = typeof Prisma;

/**
 * Биллинг: квоты диалогов и пакеты.
 *
 * Модель оплаты — pre-paid пакеты, без подписки:
 *  - free trial: 35 диалогов сразу после регистрации;
 *  - пакеты: +N диалогов к балансу (basic 150, pro 500, max 1000) или custom;
 *  - 1 диалог = 1 уникальный клиент (chatId) в рамках периода (YYYY-MM).
 *
 * Counting: на каждый inbound от нового chatId создаётся UsageEvent с
 * composite unique (userId, chatId, periodKey). Если запись новая —
 * списываем 1 с quotaTotal через quotaUsed++. В новом месяце тот же chatId
 * становится "новым клиентом" и списывается заново.
 *
 * При quotaUsed >= quotaTotal бот блокируется полностью (block_all).
 */

// Цена за диалог хранится во внутренней валюте — долларовых центах (целое).
// Цены тарифов показываем в тенге. PRICE_PER_DIALOG_KZT оставлен для обратной
// совместимости со старым API (= цена докупки по дефолтному тарифу).
export const PRICE_PER_DIALOG_KZT = 60;

export const FREE_TRIAL_DIALOGS = 35;

export type PlanId = "free" | "start" | "business" | "scale" | "enterprise" | "custom"
  // legacy id из старых Purchase-записей
  | "basic" | "pro" | "max";

export type Plan = {
  id: PlanId;
  label: string;
  description: string;
  audience?: string;
  conversations: number | null;
  // Месячная цена тарифа в тенге (null для enterprise/custom).
  monthlyPriceKzt: number | null;
  // Цена одного диалога во внутренней валюте — USD-центах.
  pricePerDialogUsdCents: number;
  // Расчётная цена за диалог в тенге (для отображения «~X тг за диалог»).
  pricePerDialogKzt: number;
  // Тариф-подписка (месячный лимит) или заявка (enterprise).
  kind: "subscription" | "enterprise";
  popular?: boolean;
  features?: string[];
  // Совместимость со старым API/UI.
  pricePerOne: number;
  totalPrice: number | null;
};

// Курс для конвертации тенге -> USD-центы (≈ 1 USD = 500 KZT). Только для
// внутреннего хранения цены за диалог; для пользователя всё в тенге.
const KZT_PER_USD = 500;
function kztPerDialogToUsdCents(kzt: number): number {
  return Math.round((kzt / KZT_PER_USD) * 100);
}

function buildPlan(p: {
  id: PlanId;
  label: string;
  description: string;
  audience: string;
  conversations: number | null;
  monthlyPriceKzt: number | null;
  kind: "subscription" | "enterprise";
  popular?: boolean;
  features?: string[];
}): Plan {
  const perDialogKzt = p.conversations && p.monthlyPriceKzt
    ? Math.round(p.monthlyPriceKzt / p.conversations)
    : PRICE_PER_DIALOG_KZT;
  return {
    ...p,
    pricePerDialogKzt: perDialogKzt,
    pricePerDialogUsdCents: kztPerDialogToUsdCents(perDialogKzt),
    pricePerOne: perDialogKzt,
    totalPrice: p.monthlyPriceKzt
  };
}

export const PLANS: Plan[] = [
  buildPlan({
    id: "start",
    label: "Старт",
    description: "Бьюти-мастера, частные консультанты.",
    audience: "Микробизнес",
    conversations: 250,
    monthlyPriceKzt: 14990,
    kind: "subscription"
  }),
  buildPlan({
    id: "business",
    label: "Бизнес",
    description: "Активные Instagram-магазины, сфера услуг, СТО.",
    audience: "Малый бизнес",
    conversations: 500,
    monthlyPriceKzt: 24990,
    kind: "subscription",
    popular: true
  }),
  buildPlan({
    id: "scale",
    label: "Масштаб",
    description: "E-commerce, клиники, агентства недвижимости.",
    audience: "Растущий бизнес",
    conversations: 1000,
    monthlyPriceKzt: 44990,
    kind: "subscription"
  }),
  buildPlan({
    id: "enterprise",
    label: "Enterprise",
    description: "Выделенный сервер, персональный менеджер по настройке промптов, приоритетная поддержка.",
    audience: "Безлимит / 1000+ диалогов",
    conversations: null,
    monthlyPriceKzt: null,
    kind: "enterprise",
    features: ["Выделенный сервер", "Персональный менеджер", "Приоритетная поддержка"]
  })
];

// Тарифы-подписки (без enterprise) — для выбора плана и расчёта докупки.
export const SUBSCRIPTION_PLANS = PLANS.filter((p) => p.kind === "subscription");

export function getPlan(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

// Кастомная докупка диалогов идёт по цене текущего тарифа пользователя.
export const CUSTOM_MIN = 50;
export const CUSTOM_MAX = 5000;
export const CUSTOM_STEP = 10;

export function currentPeriodKey(d: Date = new Date()): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export type UsageView = {
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
  // Нужно ли показать предупреждение (за 3 дня до конца / при низком остатке).
  warnExpiring: boolean;
  warnLowDialogs: boolean;
};

type UsageUserFields = {
  quotaTotal: number;
  quotaUsed: number;
  planId?: string | null;
  subscriptionEndsAt?: Date | null;
};

const LOW_DIALOGS_THRESHOLD = 10;
const EXPIRY_WARN_DAYS = 3;

export function buildUsageView(user: UsageUserFields, totalPurchased: number): UsageView {
  const remaining = Math.max(0, user.quotaTotal - user.quotaUsed);
  const endsAt = user.subscriptionEndsAt ?? null;
  let daysLeft: number | null = null;
  if (endsAt) {
    daysLeft = Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  }
  const plan = user.planId ? getPlan(user.planId) : undefined;
  return {
    total: user.quotaTotal,
    used: user.quotaUsed,
    remaining,
    exhausted: remaining <= 0,
    trialActive: totalPurchased === 0 && !user.planId,
    periodKey: currentPeriodKey(),
    planId: user.planId ?? null,
    planLabel: plan?.label ?? null,
    subscriptionEndsAt: endsAt ? endsAt.toISOString() : null,
    daysLeft,
    warnExpiring: daysLeft !== null && daysLeft <= EXPIRY_WARN_DAYS,
    warnLowDialogs: remaining > 0 && remaining <= LOW_DIALOGS_THRESHOLD
  };
}

export type TrackResult =
  | { ok: true; counted: boolean; usage: UsageView }
  | { ok: false; reason: "no_owner" | "exhausted"; usage?: UsageView };

export async function trackConversationUsage(
  prisma: PrismaClient,
  params: { agentOwnerUserId: string | null; agentId: string; chatId: string }
): Promise<TrackResult> {
  const { agentOwnerUserId, agentId, chatId } = params;

  if (!agentOwnerUserId) {
    return {
      ok: true,
      counted: false,
      usage: buildUsageView({ quotaTotal: 0, quotaUsed: 0 }, 0)
    };
  }

  const periodKey = currentPeriodKey();

  const existing = await prisma.usageEvent.findUnique({
    where: {
      userId_chatId_periodKey: { userId: agentOwnerUserId, chatId, periodKey }
    }
  });

  if (existing) {
    const user = await prisma.user.findUnique({
      where: { id: agentOwnerUserId },
      select: { quotaTotal: true, quotaUsed: true, planId: true, subscriptionEndsAt: true }
    });
    if (!user) return { ok: false, reason: "no_owner" };
    return {
      ok: true,
      counted: false,
      usage: buildUsageView(user, await sumPurchased(prisma, agentOwnerUserId))
    };
  }

  try {
    const result = await prisma.$transaction(async (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => {
      const user = await tx.user.findUnique({
        where: { id: agentOwnerUserId },
        select: { quotaTotal: true, quotaUsed: true, planId: true, subscriptionEndsAt: true }
      });
      if (!user) {
        return { kind: "no_owner" as const };
      }
      if (user.quotaUsed >= user.quotaTotal) {
        return { kind: "exhausted" as const, user };
      }
      const updated = await tx.user.updateMany({
        where: { id: agentOwnerUserId, quotaUsed: { lt: user.quotaTotal } },
        data: { quotaUsed: { increment: 1 } }
      });
      if (updated.count === 0) {
        return { kind: "exhausted" as const, user };
      }
      await tx.usageEvent.create({
        data: { userId: agentOwnerUserId, chatId, periodKey, agentId }
      });
      const fresh = await tx.user.findUniqueOrThrow({
        where: { id: agentOwnerUserId },
        select: { quotaTotal: true, quotaUsed: true, planId: true, subscriptionEndsAt: true }
      });
      return { kind: "ok" as const, user: fresh };
    });

    if (result.kind === "no_owner") return { ok: false, reason: "no_owner" };

    const totalPurchased = await sumPurchased(prisma, agentOwnerUserId);

    if (result.kind === "exhausted") {
      return {
        ok: false,
        reason: "exhausted",
        usage: buildUsageView(result.user, totalPurchased)
      };
    }
    return { ok: true, counted: true, usage: buildUsageView(result.user, totalPurchased) };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      const user = await prisma.user.findUnique({
        where: { id: agentOwnerUserId },
        select: { quotaTotal: true, quotaUsed: true, planId: true, subscriptionEndsAt: true }
      });
      if (!user) return { ok: false, reason: "no_owner" };
      return {
        ok: true,
        counted: false,
        usage: buildUsageView(user, await sumPurchased(prisma, agentOwnerUserId))
      };
    }
    throw err;
  }
}

async function sumPurchased(prisma: PrismaClient, userId: string): Promise<number> {
  const agg = await prisma.purchase.aggregate({
    where: { userId, status: "paid" },
    _sum: { conversations: true }
  });
  return agg._sum.conversations ?? 0;
}

export async function getUsageView(
  prisma: PrismaClient,
  userId: string
): Promise<UsageView | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { quotaTotal: true, quotaUsed: true, planId: true, subscriptionEndsAt: true }
  });
  if (!user) return null;
  const totalPurchased = await sumPurchased(prisma, userId);
  return buildUsageView(user, totalPurchased);
}
