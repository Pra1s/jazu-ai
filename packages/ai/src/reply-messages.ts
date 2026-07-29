// Разбор ответа модели на отдельные сообщения WhatsApp (мультисообщения).
//
// Контракт runtime-ответа переведён со строкового разделителя «---» ВНУТРИ поля
// `reply` на структурный массив `messages: string[]` (см. buildRuntimeEnvelope
// в prompts.ts, раздел «Как заполнять messages»). Причина: «---» — служебный
// токен внутри JSON-строки, и модель в JSON-режиме регулярно теряла переводы
// строк вокруг него, склеивая ответ обратно в один блок или роняя хвост с
// приклеенным к тексту разделителем прямо в чат. Массив строк как формат ответа
// в этом кодбейзе уже проверен — см. fewShot/nextQuestions/styleTraits в
// packages/ai/src/style.
//
// Модуль вынесен из prompts.ts (уже 1200+ строк) и держит вместе всё, что
// касается разбора/капа пузырей: splitBotReply (legacy-фолбэк + защита от
// рецидива), resolveBubbleCap (единственный источник правды про потолок) и
// coerceReplyMessages (сборка финального списка из сырого JSON).

import { postProcessUserText } from "./postProcess.js";
import { sanitizeAssistantText } from "./openai.js";

/**
 * Режет СЫРОЙ текст на отдельные сообщения по разделителю «---». Legacy-путь
 * (модель не вернула messages, только reply) и защита от рецидива внутри
 * одного элемента messages — модель ещё какое-то время будет по привычке
 * вставлять «---», особенно на дешёвых моделях.
 *
 * Разделитель ловится в ЛЮБОМ виде: с переводами строк, с пробелами и вплотную
 * к тексту — включая приклеенный к ссылке случай («…?utm_source=ils---Напишите»).
 * Триммит и выкидывает пустые части, при переполнении склеивает хвост через
 * пустую строку. maxMessages<=1 → всё склеивается в одну строку. Пустой ответ → [].
 *
 * Следствие: «---» ВНУТРИ URL не поддерживается (адрес будет разрезан) — так и
 * задумано, приклеенный к ссылке разделитель встречается кратно чаще, чем три
 * дефиса подряд в самом адресе.
 */
export function splitBotReply(reply: string, maxMessages = 1): string[] {
  const raw = (reply ?? "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/\s*-{3,}\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return [];
  const max = Math.max(1, Math.floor(maxMessages));
  if (parts.length <= max) return parts;
  const head = parts.slice(0, max - 1);
  const tail = parts.slice(max - 1).join("\n\n");
  return [...head, tail];
}

/**
 * Единственный источник правды про потолок пузырей мультисообщения. Раньше эта
 * формула была продублирована в трёх местах (текст промпта, cap в flush-обработчике,
 * cap в дожиме) — расхождение одной копии от других означало, что промпт обещает
 * клиенту одно число сообщений, а бэк режет по другому.
 */
export function resolveBubbleCap(
  // Оба поля объявлены ОПЦИОНАЛЬНЫМИ явно (не через Pick<BusinessProfile, ...>):
  // в z.infer-типе они non-optional (у обоих есть zod .default()), но объекты,
  // собранные вручную через `{...profile, ...} as typeof profile` (см. handler.ts
  // runtimeProfile), не гарантируют реального значения в рантайме — старые три
  // копии этой формулы защищались через `??`/`!== false` ровно по этой причине.
  profile: { replySplitEnabled?: boolean; replyMaxMessages?: number }
): number {
  if (profile.replySplitEnabled === false) return 1;
  return Math.max(1, Math.min(6, profile.replyMaxMessages ?? 4));
}

/**
 * Кап "не режь" для разбора ОДНОГО элемента messages по отдельности — реальный
 * потолок применяется один раз, ниже, к уже расплющенному списку из всех
 * элементов. Если считать по cap на каждый элемент отдельно, элемент с
 * несколькими "---" мог бы схлопнуться преждевременно, до финального среза.
 */
const UNCAPPED = 1000;

/**
 * Приводит сырой JSON-ответ модели (предпочтительно `messages: string[]`, либо
 * legacy `reply: string` с разделителем «---») к финальному списку сообщений.
 *
 * - `messages` — предпочтительный путь: каждый элемент чистим (тире/пробелы
 *   через postProcessUserText+sanitizeAssistantText) и прогоняем через
 *   splitBotReply как защиту от рецидива «---» внутри одного элемента.
 * - Без `messages` — legacy `reply: string`, тот же splitBotReply, что был
 *   единственным путём до перехода на массив (обратная совместимость).
 * - Пустой массив `messages: []` — ВАЛИДНЫЙ результат: осознанное молчание
 *   (спам/офф-топик), а не признак битого JSON. Различать «пустой массив» и
 *   «поля нет вовсе» — обязанность вызывающего кода (buildRuntimeTurn), не этой
 *   функции: она принимает уже провалидированный на верхнем уровне объект.
 * - Переполнение сверх cap: последние элементы схлопываются в один пузырь через
 *   пустую строку (не одинарный перевод строки — иначе абзацы склеиваются без
 *   видимого разделения между ними в WhatsApp).
 */
export function coerceReplyMessages(
  raw: { messages?: unknown; reply?: unknown },
  opts: { cap: number }
): string[] {
  const cap = Math.max(1, Math.floor(opts.cap));
  const clean = (text: string): string => postProcessUserText(sanitizeAssistantText(text));

  const parts = Array.isArray(raw.messages)
    ? raw.messages
        .filter((m): m is string => typeof m === "string")
        .flatMap((m) => splitBotReply(clean(m), UNCAPPED))
    : splitBotReply(clean(typeof raw.reply === "string" ? raw.reply : ""), UNCAPPED);

  if (parts.length === 0) return [];
  if (parts.length <= cap) return parts;
  const head = parts.slice(0, cap - 1);
  const tail = parts.slice(cap - 1).join("\n\n");
  return [...head, tail];
}
