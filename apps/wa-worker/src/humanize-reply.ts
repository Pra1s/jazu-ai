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

/** Длительность typing перед отправкой (не больше remainingWait). */
export function computeTypingDurationMs(
  isFirstBotReply: boolean,
  remainingWaitMs: number,
  config: HumanizeTimingConfig
): number {
  if (remainingWaitMs <= 0) return 0;
  const [minMs, maxMs] = isFirstBotReply
    ? [config.typingFirstMinMs, config.typingFirstMaxMs]
    : [config.typingMinMs, config.typingMaxMs];
  return Math.min(randomInt(minMs, maxMs), remainingWaitMs);
}

const TYPING_REFRESH_MS = 8_000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ReadBeforeReply = {
  /** За сколько мс до начала «печатает…» поставить «прочитано». */
  readLeadMs: number;
  /** Колбэк, который ставит синие галочки на входящее. */
  onRead: () => Promise<void>;
};

/**
 * Ждём до targetReplyAtMs, показываем «печатает…» в конце окна,
 * затем вызывающий код отправляет сообщение и зовёт stopTyping().
 *
 * Если передан `read`, то примерно за read.readLeadMs до начала печати
 * вызываем read.onRead() — так бот «читает» сообщение перед самым ответом,
 * а не сразу по приходу.
 */
export async function waitWithTyping(
  socket: Pick<WASocket, "sendPresenceUpdate">,
  chatId: string,
  targetReplyAtMs: number,
  isFirstBotReply: boolean,
  config: HumanizeTimingConfig,
  read?: ReadBeforeReply
): Promise<void> {
  const remainingWait = computeRemainingWait(targetReplyAtMs);
  if (remainingWait <= 0) {
    // Окно уже вышло — читаем и сразу отвечаем.
    if (read) await read.onRead();
    return;
  }

  const typingDuration = computeTypingDurationMs(isFirstBotReply, remainingWait, config);
  const silentWait = remainingWait - typingDuration;

  if (read) {
    // Молчим, читаем за ~readLeadMs до печати, ждём остаток до печати.
    const waitBeforeRead = Math.max(0, silentWait - read.readLeadMs);
    await sleep(waitBeforeRead);
    await read.onRead();
    await sleep(silentWait - waitBeforeRead);
  } else {
    await sleep(silentWait);
  }

  // Появляемся в сети только сейчас — когда реально начинаем отвечать
  // (печатать). До этого момента бот оффлайн (markOnlineOnConnect: false).
  await socket.sendPresenceUpdate("available", chatId).catch(() => undefined);

  const typingUntil = Date.now() + typingDuration;
  while (Date.now() < typingUntil) {
    await socket.sendPresenceUpdate("composing", chatId).catch(() => undefined);
    const left = typingUntil - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(TYPING_REFRESH_MS, left));
  }

  const finalWait = computeRemainingWait(targetReplyAtMs);
  await sleep(finalWait);
}

export async function stopTyping(
  socket: Pick<WASocket, "sendPresenceUpdate">,
  chatId: string
): Promise<void> {
  await socket.sendPresenceUpdate("paused", chatId).catch(() => undefined);
  // Уходим из сети сразу после ответа — бот не должен «висеть онлайн».
  await socket.sendPresenceUpdate("unavailable", chatId).catch(() => undefined);
}
