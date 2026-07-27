import { randomInt as cryptoRandomInt } from "node:crypto";
import type { WASocket } from "@whiskeysockets/baileys";

export type HumanizeTimingConfig = {
  typingMinMs: number;
  typingMaxMs: number;
  typingFirstMinMs: number;
  typingFirstMaxMs: number;
};

/** Случайное целое в [min, max] включительно. */
export function randomInt(min: number, max: number): number {
  if (max < min) return min;
  return cryptoRandomInt(min, max + 1);
}

/** Сколько ещё ждать до targetReplyAtMs (не меньше 0). */
export function computeRemainingWait(targetReplyAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, targetReplyAtMs - nowMs);
}

/** «Скорость набора»: стартовая пауза + время на символ. */
const TYPING_BASE_MS = 900;
const TYPING_MS_PER_CHAR = 38;

/** Эмуляция набора текста — сырая длительность, без клампа. */
function rawTypingMs(text: string): number {
  const len = (text ?? "").trim().length;
  return TYPING_BASE_MS + len * TYPING_MS_PER_CHAR;
}

/** Разброс вниз (85–100%), чтобы паузы не были одинаковыми от ответа к ответу. */
function jitter(ms: number): number {
  return randomInt(Math.round(ms * 0.85), ms);
}

/**
 * Сколько показывать «печатает…» перед ПЕРВЫМ сообщением ответа.
 *
 * Длительность задаёт сам текст (эмуляция набора), а НЕ остаток окна ожидания.
 * Раньше было наоборот — `min(random, remainingWait)` — и индикатор исчезал
 * совсем: к моменту отправки бюджет задержки уже съеден окном склейки входящих
 * (WA_BATCH_QUIET_MS) и работой LLM, поэтому remainingWait почти всегда 0.
 *
 * Диапазон из конфига работает как пол/потолок: короткая реплика печатается
 * минимум typingMin, длинная — не дольше typingMax.
 */
export function computeTypingDurationMs(
  isFirstBotReply: boolean,
  text: string,
  config: HumanizeTimingConfig
): number {
  const [minMs, maxMs] = isFirstBotReply
    ? [config.typingFirstMinMs, config.typingFirstMaxMs]
    : [config.typingMinMs, config.typingMaxMs];
  return Math.max(minMs, Math.min(maxMs, jitter(rawTypingMs(text))));
}

/** Presence «composing» протухает на стороне WhatsApp — обновляем чаще. */
const TYPING_REFRESH_MS = 5_000;

/** Пол/потолок паузы «печатает…» МЕЖДУ пузырями мультисообщения. */
const BUBBLE_TYPING_MIN_MS = 1_200;
const BUBBLE_TYPING_MAX_MS = 5_000;

/** Пауза между «прочитано» и началом набора, когда ждать уже нечего. */
const READ_TO_TYPING_MIN_MS = 700;
const READ_TO_TYPING_MAX_MS = 1_800;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Пауза «печатает…» между пузырями мультисообщения — та же эмуляция набора,
 * что и перед первым сообщением, но с более узким клампом: клиент уже получил
 * начало ответа и не должен долго ждать продолжения.
 */
export function computeBubblePauseMs(text: string): number {
  return Math.max(
    BUBBLE_TYPING_MIN_MS,
    Math.min(BUBBLE_TYPING_MAX_MS, jitter(rawTypingMs(text)))
  );
}

/**
 * Держит статус «печатает…» указанное время, обновляя presence, — иначе WhatsApp
 * гасит индикатор через несколько секунд. Появляемся в сети прямо здесь: до
 * начала набора бот оффлайн (markOnlineOnConnect: false).
 */
async function showTyping(
  socket: Pick<WASocket, "sendPresenceUpdate">,
  chatId: string,
  durationMs: number
): Promise<void> {
  if (durationMs <= 0) return;
  await socket.sendPresenceUpdate("available", chatId).catch(() => undefined);
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    await socket.sendPresenceUpdate("composing", chatId).catch(() => undefined);
    const left = until - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(TYPING_REFRESH_MS, left));
  }
}

/**
 * Показывает «печатает…» указанное время, затем возвращает управление —
 * вызывающий отправляет следующий пузырь. Между сообщениями бота.
 */
export async function typeBubblePause(
  socket: Pick<WASocket, "sendPresenceUpdate">,
  chatId: string,
  durationMs: number
): Promise<void> {
  await showTyping(socket, chatId, durationMs);
}

export type ReadBeforeReply = {
  /** За сколько мс до начала «печатает…» поставить «прочитано». */
  readLeadMs: number;
  /** Колбэк, который ставит синие галочки на входящее. */
  onRead: () => Promise<void>;
};

/**
 * Выдерживает «человеческую» паузу перед ответом и показывает «печатает…»
 * непосредственно перед отправкой. Порядок как у живого человека:
 * молчание (бот оффлайн) → прочитал → набирает → отправил.
 *
 * Окно ожидания до targetReplyAtMs гасится МОЛЧАНИЕМ, а набор идёт в конце:
 * итоговая задержка ≈ max(остаток окна, длительность набора). Если бюджет уже
 * израсходован (типичный случай после склейки входящих и работы LLM), молчания
 * нет, но «печатает…» показывается всё равно — иначе сообщение падает клиенту
 * без единого признака жизни.
 */
export async function waitWithTyping(
  socket: Pick<WASocket, "sendPresenceUpdate">,
  chatId: string,
  targetReplyAtMs: number,
  isFirstBotReply: boolean,
  firstBubbleText: string,
  config: HumanizeTimingConfig,
  read?: ReadBeforeReply
): Promise<void> {
  const typingDuration = computeTypingDurationMs(isFirstBotReply, firstBubbleText, config);
  const silentWait = Math.max(0, computeRemainingWait(targetReplyAtMs) - typingDuration);

  if (read) {
    // Молчим, читаем за ~readLeadMs до печати, ждём остаток до печати.
    const waitBeforeRead = Math.max(0, silentWait - read.readLeadMs);
    await sleep(waitBeforeRead);
    await read.onRead();
    const afterRead = silentWait - waitBeforeRead;
    // Даже без бюджета выдерживаем короткую паузу между галочками и набором:
    // человек сначала прочитал и лишь потом начал печатать.
    await sleep(afterRead > 0 ? afterRead : randomInt(READ_TO_TYPING_MIN_MS, READ_TO_TYPING_MAX_MS));
  } else {
    await sleep(silentWait);
  }

  // Печатаем ВПЛОТНУЮ к отправке: вызывающий шлёт сообщение сразу после return,
  // поэтому индикатор не успевает погаснуть между «печатает…» и пузырём.
  await showTyping(socket, chatId, typingDuration);
}

export async function stopTyping(
  socket: Pick<WASocket, "sendPresenceUpdate">,
  chatId: string
): Promise<void> {
  await socket.sendPresenceUpdate("paused", chatId).catch(() => undefined);
  // Уходим из сети сразу после ответа — бот не должен «висеть онлайн».
  await socket.sendPresenceUpdate("unavailable", chatId).catch(() => undefined);
}
