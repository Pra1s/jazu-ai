/**
 * Переиндексация RAG стиля по уже разобранным карточкам (без повторного анализа).
 *
 * Нужен, когда карточки (DialogueCard) есть, а векторов (StyleExchange) нет или они
 * протухли: например эмбеддинги были настроены неверно в момент прогона анализа.
 * Гоняет только эмбеддинги — сотни LLM-вызовов прохода 1/2 НЕ повторяются.
 *
 * Запуск:
 *   pnpm --filter @jazu/api exec tsx scripts/reindex-style-rag.ts user@example.com
 *   # все агенты, у которых есть карточки:
 *   pnpm --filter @jazu/api exec tsx scripts/reindex-style-rag.ts --all
 *   # dry-run (только показать, что будет сделано):
 *   pnpm --filter @jazu/api exec tsx scripts/reindex-style-rag.ts user@example.com --dry
 *
 * Идемпотентен: прежние векторы агента удаляются и пишутся заново из карточек.
 * Карточки, профиль и сам стиль (styleGuide/playbook/fewShot) не трогаются.
 */
import { prisma } from "@jazu/db";
import { indexStyleExchanges } from "@jazu/wa-pipeline";
import type { DialogueCard } from "@jazu/ai";

async function resolveAgentIds(email: string | null): Promise<string[]> {
  if (!email) {
    const rows = await prisma.dialogueCard.groupBy({ by: ["agentId"] });
    return rows.map((r) => r.agentId);
  }
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { agents: { select: { id: true }, orderBy: { createdAt: "asc" } } }
  });
  if (!user) {
    console.error(`Пользователь с email ${email} не найден.`);
    process.exit(1);
  }
  return user.agents.map((a) => a.id);
}

async function main() {
  const all = process.argv.includes("--all");
  const dry = process.argv.includes("--dry");
  const email = all ? null : process.argv[2]?.trim().toLowerCase() || null;

  if (!all && !email) {
    console.error("Использование: tsx scripts/reindex-style-rag.ts <email> | --all [--dry]");
    process.exit(1);
  }

  const agentIds = await resolveAgentIds(email);
  if (agentIds.length === 0) {
    console.log("Агентов с карточками стиля не найдено — переиндексировать нечего.");
    return;
  }

  for (const agentId of agentIds) {
    const rows = await prisma.dialogueCard.findMany({
      where: { agentId },
      select: { card: true },
      orderBy: { createdAt: "asc" }
    });
    const before = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "StyleExchange" WHERE "agentId" = ${agentId}
    `.catch(() => [] as { count: bigint }[]);

    console.log(
      `Агент ${agentId}: карточек ${rows.length}, векторов сейчас ${Number(before[0]?.count ?? 0)}` +
        (dry ? " [dry-run, без изменений]" : "")
    );
    if (dry || rows.length === 0) continue;

    await prisma.$executeRaw`DELETE FROM "StyleExchange" WHERE "agentId" = ${agentId}`;
    const indexed = await indexStyleExchanges(
      prisma,
      agentId,
      rows.map((r) => r.card as DialogueCard)
    );
    console.log(`  → проиндексировано обменов: ${indexed}.`);
    if (indexed === 0) {
      console.warn(
        "  ! ноль обменов — проверьте эмбеддинги (EMBEDDING_MODEL / ключ) и расширение vector в Postgres."
      );
    }
  }

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
