import { prisma } from "@jazu/db";
import { captureError } from "@jazu/observability";
import { logger } from "./logger.js";
import { env } from "./env.js";

/**
 * Ежедневное напоминание об окончании тарифа / исчерпании диалогов.
 *
 * Условие: за 3 дня до окончания подписки (subscriptionEndsAt) ИЛИ когда
 * осталось мало диалогов (remaining <= LOW_DIALOGS). Шлём каждый день, пока
 * условие держится: на WhatsApp (с номера бота) и на email.
 *
 * Дедупликация в рамках суток: помечаем дату последней отправки в
 * onboardingState.lastSubReminderDate (YYYY-MM-DD), чтобы не слать дважды.
 */
const LOW_DIALOGS = 10;
const WARN_DAYS = 3;

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export async function runSubscriptionReminders(): Promise<{ notified: number }> {
  const soon = new Date(Date.now() + WARN_DAYS * 24 * 3600 * 1000);

  // Кандидаты: есть активный тариф и (скоро конец ИЛИ мало диалогов).
  const users = await prisma.user.findMany({
    where: {
      deletedAt: null,
      planId: { not: null },
      OR: [
        { subscriptionEndsAt: { lte: soon } },
        // remaining <= LOW: quotaTotal - quotaUsed <= LOW — выразить в SQL
        // напрямую нельзя через prisma where по двум колонкам, фильтруем в JS.
        {}
      ]
    },
    select: {
      id: true,
      email: true,
      phone: true,
      quotaTotal: true,
      quotaUsed: true,
      subscriptionEndsAt: true,
      planId: true,
      onboardingState: true,
      agents: {
        where: { waConnections: { some: { status: "connected" } } },
        select: { id: true },
        take: 1
      }
    }
  });

  const key = todayKey();
  let notified = 0;

  for (const u of users) {
    const remaining = Math.max(0, u.quotaTotal - u.quotaUsed);
    const daysLeft = u.subscriptionEndsAt
      ? Math.ceil((u.subscriptionEndsAt.getTime() - Date.now()) / (24 * 3600 * 1000))
      : null;
    const expiring = daysLeft !== null && daysLeft <= WARN_DAYS && daysLeft >= 0;
    const lowDialogs = remaining <= LOW_DIALOGS;
    if (!expiring && !lowDialogs) continue;

    // Дедуп по дню.
    const state = (u.onboardingState as Record<string, unknown> | null) ?? {};
    if (state.lastSubReminderDate === key) continue;

    const reason = expiring
      ? `Ваш тариф заканчивается ${daysLeft === 0 ? "сегодня" : `через ${daysLeft} дн.`}`
      : `У вас осталось ${remaining} диалогов`;
    const text = `Jazu: ${reason}. Продлите тариф или докупите диалоги в личном кабинете, чтобы бот продолжал отвечать клиентам.`;

    try {
      // WhatsApp — через номер бота на личный номер владельца.
      const agentId = u.agents[0]?.id;
      if (agentId && u.phone && env.WA_WORKER_URL && env.API_INTERNAL_TOKEN) {
        const digits = u.phone.replace(/\D+/g, "");
        await fetch(new URL(`/connections/${agentId}/send`, env.WA_WORKER_URL), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-token": env.API_INTERNAL_TOKEN },
          body: JSON.stringify({ chatId: `${digits}@s.whatsapp.net`, text })
        }).catch(() => undefined);
      }

      // Email — best-effort, через API-эндпоинт нотификаций пока нет здесь,
      // поэтому логируем намерение (реальная отправка — в API-слое).
      logger.info({ userId: u.id, email: u.email, reason }, "subscription reminder (email pending)");

      await prisma.user.update({
        where: { id: u.id },
        data: { onboardingState: { ...state, lastSubReminderDate: key } }
      });
      notified++;
    } catch (err) {
      logger.error({ err, userId: u.id }, "subscription reminder failed");
      captureError(err, { route: "jobs:subscription-reminders" });
    }
  }

  return { notified };
}

export function startSubscriptionRemindersCron(): () => void {
  let stopped = false;
  const scheduleNext = () => {
    if (stopped) return;
    const now = new Date();
    const next = new Date(now);
    // Раз в сутки в 09:00 UTC (утро по локали клиентов).
    next.setUTCHours(9, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const ms = next.getTime() - now.getTime();
    const timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const res = await runSubscriptionReminders();
        logger.info({ ...res }, "subscription reminders done");
      } catch (err) {
        logger.error({ err }, "subscription reminders sweep failed");
        captureError(err, { route: "jobs:subscription-reminders" });
      } finally {
        scheduleNext();
      }
    }, ms);
    timer.unref();
    logger.info({ inMs: ms }, "subscription reminders next run scheduled");
  };
  scheduleNext();
  return () => {
    stopped = true;
  };
}
