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
  onProgress?: (p: StyleAnalysisProgress) => void | Promise<void>;
};

/**
 * Полный прогон: ранжирование → карточки (проход 1) → обобщение (проход 2) →
 * мердж стиля в BusinessProfile.data → индексация RAG. Идемпотентен: стирает
 * прежние карточки/векторы агента перед новым прогоном.
 */
export async function runStyleAnalysis(params: RunStyleAnalysisParams): Promise<StyleAnalysisResult> {
  const prisma = params.prisma ?? defaultPrisma;
  const { agentId, episodes, telemetry } = params;

  await params.onProgress?.({ stage: "ranking", total: episodes.length });
  const ranked = rankEpisodes(episodes, { limit: params.rankLimit ?? 300 }).map((r) => r.episode);

  // Идемпотентность: чистим прошлый прогон (карточки + векторы).
  await prisma.dialogueCard.deleteMany({ where: { agentId } });
  await prisma.$executeRaw`DELETE FROM "StyleExchange" WHERE "agentId" = ${agentId}`.catch(() => undefined);

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
  const artifacts = await aggregateStyle(cards, {
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

    // RAG: индексируем обмены из карточек (мягко — при недоступности pgvector просто пропустится).
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
