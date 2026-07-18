// Оркестратор анализа стиля (без БД — только LLM + чистые функции).
// Проход 1: эпизоды → карточки (ограниченный параллелизм).
// Проход 2: карточки → StyleArtifacts (map-reduce пачками).
// Прогресс наружу через колбэки; персист (БД, статус) делает вызывающий (apps/jobs).

import { runJsonCallWithTelemetry, type LlmTelemetryHooks } from "../openai.js";
import {
  buildDialogueCardPrompt,
  buildStyleAggregationPrompt,
  buildStyleMergePrompt,
  formatEpisodeForPrompt
} from "./prompts.js";
import type {
  DialogueCard,
  DialogueEpisode,
  DialogueExchange,
  StyleArtifacts
} from "./types.js";

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v.trim() : fallback;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : [];

function coerceExchanges(v: unknown): DialogueExchange[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => {
      const obj = (e ?? {}) as Record<string, unknown>;
      return {
        situation: asString(obj.situation),
        clientText: asString(obj.clientText),
        ownerText: asString(obj.ownerText)
      };
    })
    .filter((e) => e.ownerText.length > 0);
}

function coerceCard(raw: unknown): DialogueCard | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const keyMoments = Array.isArray(obj.keyMoments)
    ? obj.keyMoments
        .map((m) => {
          const o = (m ?? {}) as Record<string, unknown>;
          return {
            situation: asString(o.situation),
            ownerMove: asString(o.ownerMove),
            whyItWorked: asString(o.whyItWorked, "unclear")
          };
        })
        .filter((m) => m.situation || m.ownerMove)
    : [];
  const card: DialogueCard = {
    clientType: asString(obj.clientType),
    outcome: asString(obj.outcome, "other"),
    keyMoments,
    styleTraits: asStringArray(obj.styleTraits),
    bestExchanges: coerceExchanges(obj.bestExchanges)
  };
  // Пустая карточка (ничего не извлекли) — бесполезна, отбрасываем.
  if (card.keyMoments.length === 0 && card.bestExchanges.length === 0 && card.styleTraits.length === 0) {
    return null;
  }
  return card;
}

/** Плоские обмены из карточки — для few-shot и индексации RAG. */
export function cardToExchanges(card: DialogueCard): DialogueExchange[] {
  const fromBest = card.bestExchanges;
  const fromMoments: DialogueExchange[] = card.keyMoments
    .filter((m) => m.ownerMove)
    .map((m) => ({ situation: m.situation, clientText: "", ownerText: m.ownerMove }));
  return [...fromBest, ...fromMoments];
}

/** Анализ ОДНОГО эпизода → карточка (или null, если LLM не дал полезного). */
export async function analyzeDialogueCard(
  episode: DialogueEpisode,
  telemetry?: LlmTelemetryHooks
): Promise<DialogueCard | null> {
  const wrapper = await runJsonCallWithTelemetry<Record<string, unknown>>(
    {
      system: buildDialogueCardPrompt(),
      messages: [
        {
          role: "user",
          content: [
            "## ДИАЛОГ ДЛЯ РАЗБОРА",
            formatEpisodeForPrompt(episode),
            "",
            "Верни карточку строго в JSON по схеме из системной инструкции."
          ].join("\n")
        }
      ],
      temperature: 0.3
    },
    telemetry
  );
  if (wrapper.blocked || !wrapper.result) return null;
  return coerceCard(wrapper.result);
}

type AnalyzeOptions = {
  telemetry?: LlmTelemetryHooks;
  /** Максимум параллельных LLM-вызовов прохода 1. */
  concurrency?: number;
  /** Колбэк после каждого обработанного эпизода (для прогресса). */
  onProgress?: (done: number, total: number) => void | Promise<void>;
};

/**
 * Проход 1 по всем эпизодам с ограниченным параллелизмом.
 * Возвращает карточки в порядке эпизодов (null-и отфильтрованы).
 */
export async function analyzeEpisodes(
  episodes: DialogueEpisode[],
  options: AnalyzeOptions = {}
): Promise<Array<{ episode: DialogueEpisode; card: DialogueCard }>> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: Array<{ episode: DialogueEpisode; card: DialogueCard } | null> =
    Array.from({ length: episodes.length }, () => null);
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= episodes.length) return;
      const episode = episodes[index]!;
      try {
        const card = await analyzeDialogueCard(episode, options.telemetry);
        if (card) results[index] = { episode, card };
      } catch (err) {
        console.error("[style:analyze] episode failed", err instanceof Error ? err.message : err);
      }
      done += 1;
      await options.onProgress?.(done, episodes.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, episodes.length) }, () => worker()));
  return results.filter((r): r is { episode: DialogueEpisode; card: DialogueCard } => r !== null);
}

function coerceArtifacts(raw: unknown): StyleArtifacts | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const styleGuide = asString(obj.styleGuide);
  const playbook = asString(obj.playbook);
  const fewShot = asStringArray(obj.fewShot);
  if (!styleGuide && !playbook && fewShot.length === 0) return null;
  return { styleGuide, playbook, fewShot };
}

// Компактная сериализация карточки для промпта агрегации (без лишних полей).
function serializeCardForAggregation(card: DialogueCard): Record<string, unknown> {
  return {
    clientType: card.clientType,
    outcome: card.outcome,
    styleTraits: card.styleTraits,
    keyMoments: card.keyMoments,
    bestExchanges: card.bestExchanges
  };
}

async function aggregateBatch(
  cards: DialogueCard[],
  telemetry?: LlmTelemetryHooks
): Promise<StyleArtifacts | null> {
  const wrapper = await runJsonCallWithTelemetry<Record<string, unknown>>(
    {
      system: buildStyleAggregationPrompt(),
      messages: [
        {
          role: "user",
          content: [
            "## КАРТОЧКИ ДИАЛОГОВ",
            JSON.stringify(cards.map(serializeCardForAggregation), null, 1),
            "",
            "Обобщи в паспорт стиля, плейбук и few-shot. Верни JSON."
          ].join("\n")
        }
      ],
      temperature: 0.3
    },
    telemetry
  );
  if (wrapper.blocked || !wrapper.result) return null;
  return coerceArtifacts(wrapper.result);
}

async function mergeArtifacts(
  parts: StyleArtifacts[],
  telemetry?: LlmTelemetryHooks
): Promise<StyleArtifacts | null> {
  const wrapper = await runJsonCallWithTelemetry<Record<string, unknown>>(
    {
      system: buildStyleMergePrompt(),
      messages: [
        {
          role: "user",
          content: [
            "## ЧАСТИЧНЫЕ ПАСПОРТА СТИЛЯ",
            JSON.stringify(parts, null, 1),
            "",
            "Слей в один непротиворечивый паспорт. Верни JSON."
          ].join("\n")
        }
      ],
      temperature: 0.3
    },
    telemetry
  );
  if (wrapper.blocked || !wrapper.result) return null;
  return coerceArtifacts(wrapper.result);
}

type AggregateOptions = {
  telemetry?: LlmTelemetryHooks;
  /** Размер пачки карточек на один вызов агрегации. */
  batchSize?: number;
  onProgress?: (stage: string) => void | Promise<void>;
};

/**
 * Проход 2 (map-reduce): карточки → StyleArtifacts.
 * Пачками по batchSize → частичные паспорта → слияние (если пачек больше одной).
 */
export async function aggregateStyle(
  cards: DialogueCard[],
  options: AggregateOptions = {}
): Promise<StyleArtifacts | null> {
  if (cards.length === 0) return null;
  const batchSize = Math.max(5, options.batchSize ?? 30);

  const batches: DialogueCard[][] = [];
  for (let i = 0; i < cards.length; i += batchSize) {
    batches.push(cards.slice(i, i + batchSize));
  }

  const parts: StyleArtifacts[] = [];
  for (let i = 0; i < batches.length; i++) {
    await options.onProgress?.(`aggregating ${i + 1}/${batches.length}`);
    const part = await aggregateBatch(batches[i]!, options.telemetry);
    if (part) parts.push(part);
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;

  await options.onProgress?.("merging");
  const merged = await mergeArtifacts(parts, options.telemetry);
  if (merged) return merged;

  // Фолбэк-слияние без LLM: конкатенация + дедуп few-shot.
  return {
    styleGuide: parts.map((p) => p.styleGuide).filter(Boolean).join("\n\n"),
    playbook: parts.map((p) => p.playbook).filter(Boolean).join("\n\n"),
    fewShot: Array.from(new Set(parts.flatMap((p) => p.fewShot))).slice(0, 40)
  };
}
