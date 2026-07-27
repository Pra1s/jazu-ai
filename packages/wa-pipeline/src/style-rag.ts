// RAG по стилю владельца: индексация обменов из карточек в pgvector и retrieval
// похожих обменов под входящее сообщение. Работает через raw SQL, потому что
// Prisma Client не читает/пишет Unsupported("vector"). Всё «мягко»: любая ошибка
// (нет расширения vector, нет ключа эмбеддингов) → деградация на статичный стиль.

import { cardToExchanges, embedText, embedTexts, EMBEDDING_DIM, type DialogueCard } from "@jazu/ai";
import { prisma as defaultPrisma } from "@jazu/db";
import { randomUUID } from "node:crypto";

type PrismaClient = typeof defaultPrisma;

/** Текст, по которому матчим (триггер обмена): ситуация + реплика клиента. */
function matchText(situation: string, clientText: string, ownerText: string): string {
  return [situation, clientText].filter(Boolean).join(". ").trim() || ownerText;
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Индексирует обмены из карточек в StyleExchange. Возвращает число проиндексированных.
 * Эмбеддит «триггер» обмена (ситуация+клиент), чтобы retrieval по входящему клиенту попадал.
 */
export async function indexStyleExchanges(
  prisma: PrismaClient,
  agentId: string,
  cards: DialogueCard[]
): Promise<number> {
  const exchanges = cards
    .flatMap((c) => cardToExchanges(c))
    .filter((e) => e.ownerText.trim().length > 0);
  if (exchanges.length === 0) return 0;

  let indexed = 0;
  const BATCH = 100;
  for (let i = 0; i < exchanges.length; i += BATCH) {
    const batch = exchanges.slice(i, i + BATCH);
    const vectors = await embedTexts(batch.map((e) => matchText(e.situation, e.clientText, e.ownerText)));
    if (vectors.length !== batch.length) continue; // эмбеддинги не вернулись — пропускаем пачку
    for (let j = 0; j < batch.length; j++) {
      const e = batch[j]!;
      const vec = vectors[j];
      // Длина должна совпадать с колонкой vector(EMBEDDING_DIM): при неверно
      // настроенной модели (другая размерность) INSERT упал бы для каждой строки.
      if (!vec || vec.length !== EMBEDDING_DIM) continue;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "StyleExchange" ("id","agentId","situation","clientText","ownerText","embedding")
         VALUES ($1,$2,$3,$4,$5,$6::vector)`,
        randomUUID(),
        agentId,
        e.situation,
        e.clientText,
        e.ownerText,
        toVectorLiteral(vec)
      );
      indexed += 1;
    }
  }
  return indexed;
}

type ExchangeRow = { clientText: string; ownerText: string };

function formatExchange(row: ExchangeRow): string {
  const client = row.clientText.trim();
  const owner = row.ownerText.trim();
  return client ? `Клиент: ${client} | Владелец: ${owner}` : `Владелец: ${owner}`;
}

/**
 * Достаёт top-K обменов, наиболее похожих на входящий текст клиента.
 * Пусто при любой ошибке (нет vector-расширения, нет ключа) — бот идёт на статике.
 */
export async function retrieveStyleExamples(
  prisma: PrismaClient,
  agentId: string,
  query: string,
  topK = 5
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const vec = await embedText(trimmed);
    if (!vec || vec.length !== EMBEDDING_DIM) return [];
    const rows = await prisma.$queryRawUnsafe<ExchangeRow[]>(
      `SELECT "clientText", "ownerText"
       FROM "StyleExchange"
       WHERE "agentId" = $1 AND "embedding" IS NOT NULL
       ORDER BY "embedding" <=> $2::vector
       LIMIT $3`,
      agentId,
      toVectorLiteral(vec),
      topK
    );
    return rows.map(formatExchange);
  } catch (err) {
    console.error("[style-rag] retrieve skipped:", err instanceof Error ? err.message : err);
    return [];
  }
}
