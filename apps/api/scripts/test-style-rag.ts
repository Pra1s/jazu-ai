/**
 * Диагностика RAG стиля: что бот найдёт в базе обменов под конкретную фразу клиента.
 *
 * Показывает ровно то, что уйдёт в промпт секцией «ПРИМЕРЫ ОТВЕТОВ ВЛАДЕЛЬЦА»,
 * плюс близость (0..1) — её сам рантайм не выводит, но по ней видно, насколько
 * попадание осмысленное. Порога отсечения в рантайме НЕТ: top-K берётся всегда.
 *
 * Запуск:
 *   pnpm --filter @jazu/api exec tsx scripts/test-style-rag.ts user@example.com "сколько стоит стрижка"
 *   # своё число примеров (по умолчанию 5 — столько же берёт рантайм):
 *   pnpm --filter @jazu/api exec tsx scripts/test-style-rag.ts user@example.com "есть места на завтра?" 10
 *
 * Ничего не меняет в БД.
 */
import { prisma } from "@jazu/db";
import { embedText, EMBEDDING_DIM } from "@jazu/ai";

type Row = {
  situation: string;
  clientText: string;
  ownerText: string;
  dist: number;
  label: string | null;
};

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const query = process.argv[3]?.trim();
  const topK = Number(process.argv[4]) > 0 ? Number(process.argv[4]) : 5;

  if (!email || !query) {
    console.error('Использование: tsx scripts/test-style-rag.ts <email> "<фраза клиента>" [topK]');
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { agents: { select: { id: true }, orderBy: { createdAt: "asc" }, take: 1 } }
  });
  const agentId = user?.agents[0]?.id;
  if (!agentId) {
    console.error(`Агент для ${email} не найден.`);
    process.exit(1);
  }

  const total = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "StyleExchange"
    WHERE "agentId" = ${agentId} AND "embedding" IS NOT NULL
  `;
  console.log(`Агент ${agentId}: обменов в базе ${Number(total[0]?.count ?? 0)}`);

  const vec = await embedText(query);
  if (!vec) {
    console.error("Эмбеддинг не получен — проверьте EMBEDDING_MODEL и ключ.");
    process.exit(1);
  }
  if (vec.length !== EMBEDDING_DIM) {
    console.error(
      `Размерность ${vec.length} ≠ ${EMBEDDING_DIM} — рантайм такой вектор отбросит. ` +
        "Модель эмбеддингов не соответствует колонке vector(N)."
    );
    process.exit(1);
  }

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT e."situation", e."clientText", e."ownerText",
            (e."embedding" <=> $2::vector) AS dist,
            d."sourceChatLabel" AS label
     FROM "StyleExchange" e
     LEFT JOIN "DialogueCard" d ON d."id" = e."dialogueCardId"
     WHERE e."agentId" = $1 AND e."embedding" IS NOT NULL
     ORDER BY e."embedding" <=> $2::vector
     LIMIT $3`,
    agentId,
    `[${vec.join(",")}]`,
    topK
  );

  console.log(`\nЗапрос клиента: «${query}»`);
  console.log(`Найдено примеров: ${rows.length} (рантайм подмешивает ровно top-5)\n`);

  rows.forEach((r, i) => {
    const similarity = (1 - Number(r.dist)).toFixed(3);
    console.log(`#${i + 1}  близость ${similarity}${r.label ? `  [${r.label}]` : ""}`);
    if (r.situation) console.log(`   ситуация: ${r.situation}`);
    if (r.clientText) console.log(`   Клиент:   ${r.clientText}`);
    console.log(`   Владелец: ${r.ownerText}\n`);
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
