/**
 * Backfill: создать WaPhoneClaim для всех уже подключённых WhatsApp-сессий.
 *
 * Запуск:
 *   pnpm --filter @jazu/api exec tsx scripts/backfill-wa-phone-claims.ts
 *
 * Идемпотентен: повторный запуск не создаёт дубликаты (UNIQUE phoneHash +
 * skipDuplicates: true). Можно гонять сколько угодно раз.
 *
 * Контекст: до 2026-05-28 одного и того же WA-номера можно было привязать
 * к разным аккаунтам. Эта защита включена через WaPhoneClaim. Чтобы у уже
 * подключённых юзеров их номера сразу попали в реестр, а не только при
 * следующем reconnect — прогоняем этот скрипт сразу после миграции.
 */
import { prisma } from "@jazu/db";
import { normalizeKzRuPhone } from "../src/lib/phone.js";
import { hashWaPhone } from "../src/lib/phone-hash.js";

async function main() {
  const connections = await prisma.waConnection.findMany({
    where: {
      status: "connected",
      phone: { not: null }
    },
    select: {
      agentId: true,
      phone: true,
      agent: { select: { userId: true } }
    }
  });

  console.log(`[backfill] found ${connections.length} connected WaConnection rows`);

  let claimed = 0;
  let skippedNoOwner = 0;
  let skippedInvalidPhone = 0;
  let skippedDuplicate = 0;

  for (const conn of connections) {
    if (!conn.agent?.userId) {
      skippedNoOwner += 1;
      continue;
    }
    const normalized = normalizeKzRuPhone(conn.phone);
    if (!normalized) {
      skippedInvalidPhone += 1;
      console.warn(`[backfill] skip agent=${conn.agentId}: invalid phone ${conn.phone}`);
      continue;
    }
    const phoneHash = hashWaPhone(normalized);

    const existing = await prisma.waPhoneClaim.findUnique({
      where: { phoneHash },
      select: { userId: true }
    });

    if (existing) {
      if (existing.userId !== conn.agent.userId) {
        // Конфликт: один номер уже застолблён другим юзером (значит,
        // именно тот случай абуза, который мы хотим запретить).
        // НЕ переписываем — побеждает первый. Логируем для разбора.
        console.warn(
          `[backfill] CONFLICT agent=${conn.agentId} phoneHash=${phoneHash.slice(0, 8)}… ` +
          `connection owner=${conn.agent.userId}, claim owner=${existing.userId} — keeping claim, ` +
          `connection will be evicted on next reconnect.`
        );
      }
      skippedDuplicate += 1;
      continue;
    }

    await prisma.waPhoneClaim.create({
      data: {
        phoneHash,
        userId: conn.agent.userId,
        agentId: conn.agentId
      }
    });
    claimed += 1;
  }

  console.log(`[backfill] done: claimed=${claimed} ` +
    `skipped(no_owner)=${skippedNoOwner} ` +
    `skipped(invalid_phone)=${skippedInvalidPhone} ` +
    `skipped(duplicate)=${skippedDuplicate}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
