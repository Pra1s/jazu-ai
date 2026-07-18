// Фильтр-ранжировщик эпизодов ПЕРЕД дорогим LLM-анализом (проход 1).
// Цель: не гонять через LLM мусор («ок», «спасибо», один вопрос без ответа) и
// выбрать самые содержательные диалоги. Чистые эвристики, без сети.

import type { DialogueEpisode } from "./types.js";

export type RankOptions = {
  /** Минимум реплик в эпизоде, иначе отбрасываем. */
  minTurns?: number;
  /** Требовать хотя бы одну реплику владельца (иначе стиль извлекать не из чего). */
  requireOwner?: boolean;
  /** Сколько лучших эпизодов оставить в глубокий анализ. */
  limit?: number;
};

export const DEFAULT_RANK_OPTIONS: Required<RankOptions> = {
  minTurns: 4,
  requireOwner: true,
  limit: 300
};

export type RankedEpisode = { episode: DialogueEpisode; score: number };

// Маркеры «диалог дошёл до исхода» — такие эпизоды ценнее для плейбука.
const OUTCOME_HINTS =
  /(запиш|записал|оформ|заявк|бронир|давайте|подтвержд|перезвон|адрес|приход|ждём|ждем|до встречи|спасибо за|отправил|скину|стоит|цена|стоимость)/i;

function countChars(episode: DialogueEpisode, role: "owner" | "client"): number {
  return episode.turns
    .filter((t) => t.role === role)
    .reduce((sum, t) => sum + t.text.length, 0);
}

/**
 * Оценка содержательности эпизода. Выше = ценнее для анализа стиля.
 * Учитывает: число ходов, объём и долю реплик владельца, чередование ролей
 * (реальный диалог, а не монолог), наличие маркеров исхода.
 */
export function scoreEpisode(episode: DialogueEpisode): number {
  const turns = episode.turns;
  if (turns.length === 0) return 0;

  const ownerTurns = turns.filter((t) => t.role === "owner").length;
  const clientTurns = turns.length - ownerTurns;
  if (ownerTurns === 0 || clientTurns === 0) return 0; // монолог — бесполезен

  const ownerChars = countChars(episode, "owner");

  // Чередование: сколько раз роль меняется (диалог, а не серия монологов).
  let switches = 0;
  for (let i = 1; i < turns.length; i++) {
    if (turns[i]!.role !== turns[i - 1]!.role) switches++;
  }

  const hasOutcome = turns.some((t) => t.role === "owner" && OUTCOME_HINTS.test(t.text));

  // Баланс ролей: 1.0 при равном участии, ниже при перекосе.
  const balance = 1 - Math.abs(ownerTurns - clientTurns) / turns.length;

  return (
    turns.length * 2 +
    switches * 3 +
    Math.min(ownerChars, 1500) / 100 +
    balance * 5 +
    (hasOutcome ? 8 : 0)
  );
}

/**
 * Фильтрует мусор и возвращает топ эпизодов по убыванию оценки.
 * Детерминирован: при равных оценках порядок стабилен (по исходному индексу).
 */
export function rankEpisodes(
  episodes: DialogueEpisode[],
  options: RankOptions = {}
): RankedEpisode[] {
  const opts = { ...DEFAULT_RANK_OPTIONS, ...options };

  const eligible = episodes
    .map((episode, index) => ({ episode, index, score: scoreEpisode(episode) }))
    .filter(({ episode, score }) => {
      if (episode.turns.length < opts.minTurns) return false;
      if (score <= 0) return false;
      if (opts.requireOwner && !episode.turns.some((t) => t.role === "owner")) return false;
      return true;
    });

  eligible.sort((a, b) => (b.score - a.score) || (a.index - b.index));

  return eligible.slice(0, opts.limit).map(({ episode, score }) => ({ episode, score }));
}
