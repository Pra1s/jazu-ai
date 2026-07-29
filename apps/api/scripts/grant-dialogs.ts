/**
 * Ручное начисление диалогов (квоты) аккаунту — админская операция без оплаты.
 *
 * Запуск:
 *   # докупка: просто прибавить 500 диалогов к текущей квоте
 *   pnpm --filter @jazu/api exec tsx scripts/grant-dialogs.ts user@example.com 500
 *
 *   # выдать тариф целиком (как покупка в кабинете): квота = использовано + пакет,
 *   # planId и подписка на 30 дней
 *   pnpm --filter @jazu/api exec tsx scripts/grant-dialogs.ts user@example.com --plan business
 *   pnpm --filter @jazu/api exec tsx scripts/grant-dialogs.ts user@example.com --plan scale --days 90
 *
 *   # посмотреть, ничего не меняя
 *   pnpm --filter @jazu/api exec tsx scripts/grant-dialogs.ts user@example.com 500 --dry
 *
 * Семантика повторяет POST /billing/purchase:
 *  - докупка       → quotaTotal += N (остаток растёт на N);
 *  - выдача тарифа → quotaTotal = quotaUsed + пакет (месячный лимит поверх
 *    текущего использования; quotaUsed НЕ сбрасывается — это счётчик уникальных
 *    клиентов за всё время).
 *
 * Пишет строку в Purchase с amount=0 и packageId `manual_*`, чтобы начисление
 * было видно в истории и не путалось с реальной оплатой.
 */
import { prisma } from "@jazu/db";
import { getPlan, SUBSCRIPTION_PLANS } from "@jazu/wa-pipeline";

function parseArgs() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const email = argv[0]?.trim().toLowerCase();

  const planIdx = argv.indexOf("--plan");
  const planId = planIdx >= 0 ? argv[planIdx + 1]?.trim() : undefined;

  const daysIdx = argv.indexOf("--days");
  const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 30;

  // Количество — первый числовой ПОЗИЦИОННЫЙ аргумент после email. Значения
  // флагов (`--days 90`) пропускаем, иначе 90 уехало бы в количество диалогов.
  const consumed = new Set<number>();
  if (planIdx >= 0) consumed.add(planIdx).add(planIdx + 1);
  if (daysIdx >= 0) consumed.add(daysIdx).add(daysIdx + 1);
  const countArg = argv.find((a, i) => i > 0 && !consumed.has(i) && /^\d+$/.test(a));
  const count = countArg ? Number(countArg) : undefined;

  return { email, planId, days, count, dry };
}

async function main() {
  const { email, planId, days, count, dry } = parseArgs();

  if (!email || (!planId && !count)) {
    console.error(
      "Использование:\n" +
        "  tsx scripts/grant-dialogs.ts <email> <количество> [--dry]\n" +
        "  tsx scripts/grant-dialogs.ts <email> --plan <planId> [--days 30] [--dry]\n" +
        `Доступные тарифы: ${SUBSCRIPTION_PLANS.map((p) => `${p.id} (${p.conversations})`).join(", ")}`
    );
    process.exit(1);
  }
  if (planId && !getPlan(planId)) {
    console.error(
      `Тариф «${planId}» не найден. Доступные: ${SUBSCRIPTION_PLANS.map((p) => p.id).join(", ")}`
    );
    process.exit(1);
  }
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days должно быть положительным числом.");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: {
      id: true,
      email: true,
      quotaTotal: true,
      quotaUsed: true,
      planId: true,
      subscriptionEndsAt: true
    }
  });
  if (!user) {
    console.error(`Пользователь с email ${email} не найден.`);
    process.exit(1);
  }

  console.log(
    `${user.email}: квота ${user.quotaTotal}, использовано ${user.quotaUsed}, ` +
      `осталось ${user.quotaTotal - user.quotaUsed}, тариф ${user.planId ?? "нет"}` +
      (user.subscriptionEndsAt ? ` до ${user.subscriptionEndsAt.toISOString().slice(0, 10)}` : "")
  );

  const plan = planId ? getPlan(planId) : undefined;
  const conversations = plan?.conversations ?? count ?? 0;
  if (conversations <= 0) {
    console.error("Пакет тарифа не содержит диалогов (enterprise?) — укажите количество явно.");
    process.exit(1);
  }

  // Итоговая квота: тариф задаёт лимит поверх использования, докупка прибавляет.
  const nextQuotaTotal = plan ? user.quotaUsed + conversations : user.quotaTotal + conversations;
  const endsAt = plan ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : user.subscriptionEndsAt;

  console.log(
    `Станет: квота ${nextQuotaTotal} (осталось ${nextQuotaTotal - user.quotaUsed})` +
      (plan ? `, тариф ${plan.id} до ${endsAt?.toISOString().slice(0, 10)}` : "") +
      (dry ? " [dry-run, без изменений]" : "")
  );
  if (dry) return;

  await prisma.$transaction(async (tx) => {
    await tx.purchase.create({
      data: {
        userId: user.id,
        packageId: plan ? `manual_${plan.id}` : "manual_topup",
        conversations,
        pricePerOne: 0,
        amount: 0,
        currency: "KZT",
        status: "paid",
        metadata: { grantedBy: "grant-dialogs.ts", reason: "manual grant" }
      }
    });
    await tx.user.update({
      where: { id: user.id },
      data: {
        quotaTotal: nextQuotaTotal,
        ...(plan ? { planId: plan.id, subscriptionEndsAt: endsAt } : {})
      }
    });
  });

  console.log("Готово.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
