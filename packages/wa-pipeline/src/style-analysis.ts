// DB-aware оркестрация анализа стиля владельца. Общий код для:
//   - apps/api/scripts/analyze-style.ts (MVP-прогон из CLI);
//   - apps/jobs (хендлер очереди style:analyze).
// Чистая LLM-логика живёт в @jazu/ai (parse/rank/analyze); здесь — персист карточек,
// мердж стиля в профиль и индексация RAG.

import {
  aggregateStyle,
  analyzeEpisodes,
  cardToExchanges,
  rankEpisodes,
  reviveEpisodeDates,
  type DialogueCard,
  type DialogueEpisode,
  type LlmTelemetryHooks,
  type StyleArtifacts
} from "@jazu/ai";
import { prisma as defaultPrisma, type Prisma } from "@jazu/db";
import { businessProfileSchema } from "@jazu/shared";
import { indexStyleExchanges } from "./style-rag.js";

type PrismaClient = typeof defaultPrisma;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export type StyleAnalysisProgress = {
  stage: "ranking" | "analyzing" | "aggregating" | "indexing" | "saving" | "done";
  done?: number;
  total?: number;
};

export type StyleAnalysisResult = {
  totalEpisodes: number;
  rankedEpisodes: number;
  cardsCreated: number;
  artifacts: StyleArtifacts | null;
  /** append-режим: все присланные диалоги уже разобраны прошлыми прогонами. */
  nothingNew?: boolean;
};

export type RunStyleAnalysisParams = {
  prisma?: PrismaClient;
  agentId: string;
  episodes: DialogueEpisode[];
  ownerName?: string;
  telemetry?: LlmTelemetryHooks;
  /** Сколько лучших эпизодов брать в глубокий анализ. */
  rankLimit?: number;
  /** Параллелизм прохода 1. */
  concurrency?: number;
  /**
   * "replace" (по умолчанию) — прогон с нуля: прежние карточки и векторы агента
   * стираются, стиль строится только по присланным эпизодам.
   * "append" — дозагрузка: прежние карточки/векторы остаются, анализируются только
   * новые эпизоды, а паспорт стиля пересобирается по старым + новым карточкам.
   */
  mode?: "replace" | "append";
  onProgress?: (p: StyleAnalysisProgress) => void | Promise<void>;
};

/**
 * Потолок карточек, уходящих в проход 2 (append-режим). Обобщение стоит один
 * LLM-вызов на каждые 30 карточек + финальный merge, поэтому при многократных
 * дозагрузках берём все новые карточки и добиваем самыми свежими старыми.
 */
const APPEND_AGGREGATE_LIMIT = 400;

/** Ключ дедупликации эпизода: тот же чат + тот же индекс = тот же диалог. */
function episodeKey(chatLabel: string, episodeIndex: number): string {
  return `${chatLabel}#${episodeIndex}`;
}

/**
 * Полный прогон: ранжирование → карточки (проход 1) → обобщение (проход 2) →
 * мердж стиля в BusinessProfile.data → индексация RAG. Идемпотентен: стирает
 * прежние карточки/векторы агента перед новым прогоном.
 */
export async function runStyleAnalysis(params: RunStyleAnalysisParams): Promise<StyleAnalysisResult> {
  const prisma = params.prisma ?? defaultPrisma;
  const { agentId, telemetry } = params;
  // Оживляем Date-поля: эпизоды могли прийти после round-trip через JSONB
  // (роут → StyleAnalysis.episodes → хендлер), где Date стал ISO-строкой.
  const episodes = reviveEpisodeDates(params.episodes);

  const append = params.mode === "append";

  await params.onProgress?.({ stage: "ranking", total: episodes.length });

  // append: поднимаем уже разобранные карточки. Они нужны дважды — как фильтр
  // дублей (повторная загрузка того же файла не должна жечь токены заново) и как
  // вход прохода 2, чтобы паспорт стиля учитывал и старые диалоги.
  let existingCards: DialogueCard[] = [];
  let fresh = episodes;
  if (append) {
    const rows = await prisma.dialogueCard.findMany({
      where: { agentId },
      select: { card: true, sourceChatLabel: true, episodeIndex: true },
      orderBy: { createdAt: "desc" }
    });
    existingCards = rows.map((r) => r.card as DialogueCard);
    const seen = new Set(rows.map((r) => episodeKey(r.sourceChatLabel, r.episodeIndex)));
    fresh = episodes.filter((e) => !seen.has(episodeKey(e.chatLabel, e.episodeIndex)));
    if (fresh.length === 0) {
      await params.onProgress?.({ stage: "done" });
      return {
        totalEpisodes: episodes.length,
        rankedEpisodes: 0,
        cardsCreated: 0,
        artifacts: null,
        nothingNew: true
      };
    }
  }

  const ranked = rankEpisodes(fresh, { limit: params.rankLimit ?? 300 }).map((r) => r.episode);

  // Идемпотентность replace-прогона: чистим прошлый прогон (карточки + векторы).
  // В append-режиме прошлое сохраняем — в этом весь смысл дозагрузки.
  if (!append) {
    await prisma.dialogueCard.deleteMany({ where: { agentId } });
    await prisma.$executeRaw`DELETE FROM "StyleExchange" WHERE "agentId" = ${agentId}`.catch(() => undefined);
  }

  await params.onProgress?.({ stage: "analyzing", done: 0, total: ranked.length });
  const analyzed = await analyzeEpisodes(ranked, {
    ...(telemetry ? { telemetry } : {}),
    concurrency: params.concurrency ?? 4,
    onProgress: async (done, total) => {
      await params.onProgress?.({ stage: "analyzing", done, total });
    }
  });

  // Персист карточек.
  const cards: DialogueCard[] = [];
  for (const { episode, card } of analyzed) {
    cards.push(card);
    await prisma.dialogueCard.create({
      data: {
        agentId,
        sourceChatLabel: episode.chatLabel,
        episodeIndex: episode.episodeIndex,
        card: jsonInput(card),
        excerpts: jsonInput(cardToExchanges(card))
      }
    });
  }

  await params.onProgress?.({ stage: "aggregating" });
  // Проход 2 идёт по новым карточкам + (в append-режиме) по прежним, чтобы стиль
  // описывал всю накопленную переписку, а не только последнюю загрузку.
  const cardsForAggregate = append
    ? [...cards, ...existingCards].slice(0, APPEND_AGGREGATE_LIMIT)
    : cards;
  const artifacts = await aggregateStyle(cardsForAggregate, {
    ...(telemetry ? { telemetry } : {}),
    onProgress: async () => {
      await params.onProgress?.({ stage: "aggregating" });
    }
  });

  // Мердж стиля в профиль (стиль читается envelope на каждом ответе).
  if (artifacts) {
    await params.onProgress?.({ stage: "saving" });
    const existing = await prisma.businessProfile.findUnique({ where: { agentId } });
    const base = existing ? businessProfileSchema.parse(existing.data) : businessProfileSchema.parse({});
    const merged = {
      ...base,
      styleGuide: artifacts.styleGuide || base.styleGuide,
      stylePlaybook: artifacts.playbook || base.stylePlaybook,
      styleFewShot: artifacts.fewShot.length > 0 ? artifacts.fewShot : base.styleFewShot
    };
    await prisma.businessProfile.upsert({
      where: { agentId },
      update: { data: jsonInput(merged) },
      create: { agentId, data: jsonInput(merged) }
    });

    // RAG: индексируем обмены новых карточек (мягко — при недоступности pgvector
    // просто пропустится). В append-режиме прежние векторы остаются на месте.
    await params.onProgress?.({ stage: "indexing" });
    await indexStyleExchanges(prisma, agentId, cards).catch((err) => {
      console.error("[style-analysis] RAG indexing skipped:", err instanceof Error ? err.message : err);
    });
  } else if (append && cards.length > 0) {
    // Паспорт стиля пересобрать не вышло, но карточки уже созданы и следующий
    // прогон отфильтрует их как дубли — значит обмены надо проиндексировать
    // сейчас, иначе эти диалоги не попадут в RAG никогда.
    await params.onProgress?.({ stage: "indexing" });
    await indexStyleExchanges(prisma, agentId, cards).catch((err) => {
      console.error("[style-analysis] RAG indexing skipped:", err instanceof Error ? err.message : err);
    });
  }

  await params.onProgress?.({ stage: "done" });
  return {
    totalEpisodes: episodes.length,
    rankedEpisodes: ranked.length,
    cardsCreated: cards.length,
    artifacts
  };
}

/** Полностью сносит стиль агента: карточки, векторы и поля стиля в профиле. */
export async function clearStyle(prisma: PrismaClient, agentId: string): Promise<void> {
  await prisma.dialogueCard.deleteMany({ where: { agentId } });
  await prisma.$executeRaw`DELETE FROM "StyleExchange" WHERE "agentId" = ${agentId}`.catch(() => undefined);
  const existing = await prisma.businessProfile.findUnique({ where: { agentId } });
  if (existing) {
    const base = businessProfileSchema.parse(existing.data);
    const cleared = { ...base, styleGuide: undefined, stylePlaybook: undefined, styleFewShot: [] };
    await prisma.businessProfile.update({ where: { agentId }, data: { data: jsonInput(cleared) } });
  }
  await prisma.styleAnalysis.deleteMany({ where: { agentId } });
}
