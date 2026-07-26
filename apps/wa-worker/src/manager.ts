import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeWASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { env } from "./env.js";
import { useDbAuthState } from "./db-auth-state.js";
import { getInboundQueue, type WaInboundJob } from "@jazu/queue";
import {
  computeBubblePauseMs,
  randomInt,
  stopTyping,
  typeBubblePause,
  waitWithTyping,
  type HumanizeTimingConfig
} from "./humanize-reply.js";

type PublicConnectionState = {
  status: "disconnected" | "qr" | "pairing" | "connected" | "error";
  qrText?: string | null;
  qrDataUrl?: string | null;
  phone?: string | null;
  workerSessionId?: string | null;
  lastSeenAt?: string | null;
};

type ManagedConnection = {
  agentId: string;
  socket?: ReturnType<typeof makeWASocket>;
  status: PublicConnectionState["status"];
  qrText?: string | null;
  qrDataUrl?: string | null;
  phone?: string | null;
  workerSessionId: string;
  lastSeenAt?: Date | null;
  stopRequested: boolean;
  /** Per-chat rate-limit: timestamp последнего исходящего на chatId, ms. */
  lastSentAt: Map<string, number>;
  /**
   * id сообщений, отправленных САМИМ ботом через этот сокет. Нужен как страховка
   * при разборе `fromMe`-сообщений: свои отправки Baileys отдаёт типом `append`
   * (мы их и так не слушаем), но если эхо всё же прилетит как `notify` — не
   * запишем ответ бота второй раз, уже как ручной. Ограничен по размеру.
   */
  selfSentIds: Set<string>;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempts: number;
  /** Фича «бот в стиле владельца»: захватывать ли личную историю при синке
   *  (по согласию владельца, per-agent). Живёт между внутренними рестартами. */
  styleHistoryCapture: boolean;
  /** Fallback-таймер завершения history-sync, если Baileys не пришлёт isLatest. */
  historySyncTimer?: NodeJS.Timeout;
  /** Активен ли pairing-code flow. Если да — игнорируем QR-эвенты от Baileys
   * и держим status="pairing", чтобы UI не прыгал. */
  pairingMode: boolean;
  /** Последний выданный 8-значный код (для идемпотентного повторного запроса
   * в течение TTL). WhatsApp pairing codes валидны ~60 секунд. */
  pairingCode?: string | null;
  pairingCodeIssuedAt?: number;
  pairingPhone?: string | null;
};

/** TTL pairing code на стороне WhatsApp — около 60с. Чуть занижаем,
 * чтобы успеть сгенерить новый если юзер тормозит. */
const PAIRING_CODE_TTL_MS = 50_000;

/** Сколько ждать новых чанков history-sync, прежде чем считать синк завершённым.
 * WhatsApp шлёт историю порциями с паузами; сообщения (RECENT/FULL) нередко
 * приходят через десятки секунд после статусных чанков. */
const HISTORY_QUIET_MS = 60_000;

type WAMessageLike = {
  key: {
    fromMe?: boolean | null;
    remoteJid?: string | null;
    /** Для @lid-чатов реальный PN (`<номер>@s.whatsapp.net`) лежит здесь. */
    remoteJidAlt?: string | null;
    id?: string | null;
    participant?: string | null;
  };
  pushName?: string | null;
  /** Unix-секунды (Baileys: number | Long). Возраст оригинального сообщения. */
  messageTimestamp?: number | { toNumber?: () => number } | null;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    imageMessage?: { caption?: string | null } | null;
    videoMessage?: { caption?: string | null } | null;
    documentMessage?: { caption?: string | null } | null;
    /** Голосовое/аудио. ptt=true — кружок-голосовое; mimetype обычно
     *  "audio/ogg; codecs=opus". Скачиваем байты и отдаём в STT. */
    audioMessage?: { mimetype?: string | null; seconds?: number | null; ptt?: boolean | null } | null;
  } | null;
};

/** Потолок размера аудио (~25 МБ — лимит STT-провайдеров). Голосовые WhatsApp
 *  почти всегда сильно меньше; берём с запасом, чтобы принимать практически всё. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Скачивает байты голосового/аудио сообщения и кодирует в base64.
 * Возвращает null, если аудио нет, оно слишком большое или скачать не удалось —
 * в таких случаях сообщение просто пропускается (бот не падает).
 */
async function downloadVoiceAudio(
  message: WAMessageLike
): Promise<{ base64: string; mimeType: string } | null> {
  const audio = message.message?.audioMessage;
  if (!audio) {
    return null;
  }
  try {
    // Свежие notify-сообщения скачиваются без reuploadRequest (ctx опционален).
    const buffer = await downloadMediaMessage(
      message as unknown as WAMessage,
      "buffer",
      {}
    );
    if (buffer.length > MAX_AUDIO_BYTES) {
      console.warn(`WA voice audio too large (${buffer.length} bytes) — skipping`);
      return null;
    }
    return {
      base64: buffer.toString("base64"),
      mimeType: audio.mimetype || "audio/ogg; codecs=opus"
    };
  } catch (err) {
    console.error("Failed to download WA voice audio:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Baileys присылает messageTimestamp либо как number, либо как Long
 *  (зависит от proto-парсинга). Унифицируем в number или undefined. */
function extractMessageTimestamp(ts: WAMessageLike["messageTimestamp"]): number | undefined {
  if (ts === null || ts === undefined) return undefined;
  if (typeof ts === "number") return ts;
  if (typeof ts === "object" && typeof ts.toNumber === "function") {
    return ts.toNumber();
  }
  return undefined;
}

function getTextMessage(message: WAMessageLike): string | null {
  const content = message.message;
  if (!content) {
    return null;
  }

  const candidates = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption
  ];

  return candidates.find((item): item is string => typeof item === "string" && item.trim().length > 0) ?? null;
}

function chatKey(agentId: string, chatId: string): string {
  return `${agentId}:${chatId}`;
}

function humanizeTimingConfig(): HumanizeTimingConfig {
  return {
    typingMinMs: env.WA_TYPING_MIN_MS,
    typingMaxMs: env.WA_TYPING_MAX_MS,
    typingFirstMinMs: env.WA_TYPING_FIRST_MIN_MS,
    typingFirstMaxMs: env.WA_TYPING_FIRST_MAX_MS
  };
}

function computeTargetReplyAtMs(inboundReceivedAtMs: number, isFirstBotReply: boolean): number {
  const [minMs, maxMs] = isFirstBotReply
    ? [env.WA_REPLY_DELAY_FIRST_MIN_MS, env.WA_REPLY_DELAY_FIRST_MAX_MS]
    : [env.WA_REPLY_DELAY_MIN_MS, env.WA_REPLY_DELAY_MAX_MS];
  return inboundReceivedAtMs + randomInt(minMs, maxMs);
}

/**
 * Ждёт, пока Baileys-сокет реально откроет WebSocket-handshake с WA серверами.
 *
 * Признак реальной готовности — первый `qr` event ИЛИ `connection: "open"`.
 * `connection: "connecting"` НЕ годится — это только ws.open, до noise-handshake.
 * На таком сокете sendNode (внутри requestPairingCode) валит соединение.
 *
 * Бросает Error если за timeoutMs готовность не пришла.
 */
async function waitForSocketReady(socket: ReturnType<typeof makeWASocket>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WhatsApp socket не готов за ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (update: { qr?: string; connection?: string; lastDisconnect?: { error?: Error | undefined } }) => {
      if (update.qr || update.connection === "open") {
        cleanup();
        resolve();
        return;
      }
      if (update.connection === "close") {
        cleanup();
        reject(new Error(`WhatsApp закрыл соединение: ${update.lastDisconnect?.error?.message ?? "unknown"}`));
      }
    };

    function cleanup() {
      clearTimeout(timer);
      socket.ev.off("connection.update", handler);
    }

    socket.ev.on("connection.update", handler);
  });
}

/** Принудительно затирает WaConnection.authState в БД через API.
 * Используется когда pairing failed, чтобы partial creds (me без registered)
 * не утащили следующую попытку в passive=true login. */
async function wipeAuthStateInDb(agentId: string): Promise<void> {
  await fetch(new URL(`/api/internal/wa-auth/${agentId}`, env.API_ORIGIN), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": env.API_INTERNAL_TOKEN
    },
    body: "{}"
  });
}

/**
 * Атомарно «застолбить» номер за владельцем агента через API.
 *
 * Зовётся ОДИН раз — в момент успешного pairing (connection.update→open),
 * когда socket.user.id уже содержит реальный номер. API хэширует, проверяет
 * уникальность в WaPhoneClaim, и:
 *   - ok: true                      → номер наш или уже наш, продолжаем
 *   - ok: false, ALREADY_BOUND      → этот номер у другого аккаунта,
 *                                     надо немедленно разорвать сессию
 *   - ok: false, любая другая       → лучше тоже разорвать, чтобы не оставить
 *                                     юзера в подвешенном состоянии
 *
 * При сетевой ошибке возвращает { ok: false, networkError: true } — в этом
 * случае мы НЕ рвём сессию (не наказываем юзера за наш сбой инфраструктуры),
 * просто логируем и идём дальше. Claim создастся при следующем reconnect.
 */
async function claimWaPhone(agentId: string, phoneDigits: string): Promise<{
  ok: boolean;
  reason?: string;
  message?: string;
  networkError?: boolean;
}> {
  try {
    const res = await fetch(new URL("/api/internal/wa-claim", env.API_ORIGIN), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": env.API_INTERNAL_TOKEN
      },
      body: JSON.stringify({ agentId, phone: phoneDigits })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      reason?: string;
      message?: string;
    };
    if (data.ok) return { ok: true };
    return {
      ok: false,
      reason: data.reason ?? "UNKNOWN",
      message: data.message ?? "WA phone claim rejected"
    };
  } catch (err) {
    console.error("[wa-claim] network error:", err instanceof Error ? err.message : err);
    return { ok: false, networkError: true };
  }
}

/**
 * Извлечь цифры номера из Baileys socket.user.id.
 * Формат: "77001234567:1@s.whatsapp.net" или "77001234567@s.whatsapp.net".
 * Возвращаем 7XXXXXXXXXX (без + и без device suffix).
 */
function extractPhoneFromJid(jid: string | undefined): string | null {
  if (!jid) return null;
  const local = jid.split("@")[0] ?? "";
  const digits = local.split(":")[0] ?? "";
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

async function pushStatusToApi(agentId: string, payload: {
  status: "disconnected" | "qr" | "pairing" | "connected" | "error";
  qrText?: string | null;
  qrDataUrl?: string | null;
  phone?: string | null;
  workerSessionId?: string | null;
  /** ISO-строка. Передаётся ТОЛЬКО при connection.open после успешного claim —
   *  значит «начни отвечать с этого момента, всё что раньше — игнор». */
  botRespondsSince?: string | null;
}) {
  try {
    await fetch(new URL("/api/whatsapp/qr-update", env.API_ORIGIN), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": env.API_INTERNAL_TOKEN
      },
      body: JSON.stringify({ agentId, ...payload })
    });
  } catch {
    // Non-critical: status push failed, will sync on next poll
  }
}

/**
 * Отправить в API список chatId, существовавших ДО подключения (из
 * history-sync). API сам решит, добавлять ли их (только в окне свежей
 * привязки — см. botRespondsSince). Best-effort.
 */
async function pushPreConnectionChats(agentId: string, chatIds: string[]): Promise<void> {
  if (chatIds.length === 0) return;
  try {
    await fetch(new URL("/api/internal/wa-preconnection-chats", env.API_ORIGIN), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": env.API_INTERNAL_TOKEN
      },
      body: JSON.stringify({ agentId, chatIds })
    });
  } catch (err) {
    console.error(
      "[wa] push pre-connection chats failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Фича «бот в стиле владельца» (продуктовый источник). Собирает ТЕКСТ личных
 * диалогов из history-sync для последующего анализа стиля владельца. Только личные
 * чаты (не группы/броадкасты), только текст, с таймингами и признаком fromMe.
 * Возвращает диалоги с >= 4 реплик — короткие для анализа бесполезны.
 */
type HistoryDialogueMsg = { fromMe: boolean; text: string; ts?: number };
type HistoryDialogue = {
  waChatId: string;
  label: string;
  messages: HistoryDialogueMsg[];
  /** Unix-секунды самого свежего сообщения — для сортировки «последние диалоги». */
  lastTs?: number;
};

function isPersonalJid(jid: string): boolean {
  if (jid === "status@broadcast") return false;
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return false;
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid") || jid.endsWith("@c.us");
}

function collectHistoryDialogues(payload: {
  chats?: Array<{ id?: string | null; name?: string | null }> | null;
  messages?: Array<WAMessageLike> | null;
}): HistoryDialogue[] {
  const names = new Map<string, string>();
  for (const c of payload.chats ?? []) {
    if (c?.id && c?.name) names.set(c.id, c.name);
  }
  const byChat = new Map<string, HistoryDialogue>();
  // Лучшее имя/номер клиента для лейбла (чтобы не показывать @lid).
  const pushNames = new Map<string, string>();
  const phones = new Map<string, string>();
  for (const m of payload.messages ?? []) {
    const jid = m?.key?.remoteJid;
    if (!jid || !isPersonalJid(jid)) continue;
    // pushName у входящих (не fromMe) — это имя контакта в его настройках.
    if (!m.key?.fromMe && m.pushName && !pushNames.has(jid)) pushNames.set(jid, m.pushName.trim());
    // Реальный номер для @lid берём из remoteJidAlt.
    if (!phones.has(jid)) {
      const phone = realPhoneFromKey(m.key ?? {});
      if (phone) phones.set(jid, phone);
    }
    const text = getTextMessage(m);
    if (!text) continue;
    const entry = byChat.get(jid) ?? { waChatId: jid, label: "", messages: [] };
    const ts = extractMessageTimestamp(m.messageTimestamp);
    if (ts !== undefined && (entry.lastTs === undefined || ts > entry.lastTs)) entry.lastTs = ts;
    entry.messages.push({
      fromMe: Boolean(m.key?.fromMe),
      text,
      ...(ts !== undefined ? { ts } : {})
    });
    byChat.set(jid, entry);
  }
  // Лейбл: сохранённое имя чата → имя контакта (pushName) → «+номер» → пусто (API
  // покажет waChatId). Так пользователь узнаёт свои чаты, а не видит @lid.
  for (const [jid, entry] of byChat) {
    const phone = phones.get(jid);
    entry.label =
      names.get(jid) ||
      pushNames.get(jid) ||
      (phone ? `+${phone}` : "") ||
      "";
  }
  // Кап на диалог = лимит zod на API (иначе весь пакет из 40 диалогов отвергнется
  // с ZodError). Держим последние сообщения — свежая переписка репрезентативнее.
  const MAX_MSGS_PER_DIALOGUE = 5000;
  return Array.from(byChat.values())
    .filter((d) => d.messages.length >= 4)
    .map((d) =>
      d.messages.length > MAX_MSGS_PER_DIALOGUE
        ? { ...d, messages: d.messages.slice(-MAX_MSGS_PER_DIALOGUE) }
        : d
    );
}

/** Пушит буфер личных диалогов в API пачками (для анализа стиля). Best-effort. */
async function pushHistoryDialogues(agentId: string, dialogues: HistoryDialogue[]): Promise<void> {
  if (dialogues.length === 0) return;
  const BATCH = 40;
  for (let i = 0; i < dialogues.length; i += BATCH) {
    const chunk = dialogues.slice(i, i + BATCH);
    try {
      const res = await fetch(new URL("/api/internal/wa-history-dialogues", env.API_ORIGIN), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-token": env.API_INTERNAL_TOKEN },
        body: JSON.stringify({ agentId, dialogues: chunk })
      });
      if (!res.ok) {
        console.error(
          `[wa] push history dialogues rejected: ${res.status} (chunk ${i}-${i + chunk.length})`
        );
      }
    } catch (err) {
      console.error("[wa] push history dialogues failed:", err instanceof Error ? err.message : err);
    }
  }
}

/** Сообщает API прогресс history-sync (для статус-бара в UI). Best-effort. */
async function pushHistoryProgress(
  agentId: string,
  payload: { progress: number | null; status: "syncing" | "done" }
): Promise<void> {
  try {
    const res = await fetch(new URL("/api/internal/wa-history-progress", env.API_ORIGIN), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": env.API_INTERNAL_TOKEN },
      body: JSON.stringify({ agentId, ...payload })
    });
    if (!res.ok) {
      console.error(`[wa] push history progress rejected: ${res.status}`);
    }
  } catch (err) {
    console.error("[wa] push history progress failed:", err instanceof Error ? err.message : err);
  }
}

/** Извлекает chatId (remoteJid) из history-sync payload. Берём и из chats,
 *  и из messages — чтобы максимально полно покрыть «до-коннектные» чаты.
 *  Игнорируем статусы/броадкасты — это не реальные диалоги. */
function collectHistoryChatIds(payload: {
  chats?: Array<{ id?: string | null }> | null;
  messages?: Array<{ key?: { remoteJid?: string | null } | null }> | null;
}): string[] {
  const ids = new Set<string>();
  const add = (jid: string | null | undefined) => {
    if (!jid) return;
    if (jid === "status@broadcast") return;
    ids.add(jid);
  };
  for (const c of payload.chats ?? []) add(c?.id);
  for (const m of payload.messages ?? []) add(m?.key?.remoteJid);
  return Array.from(ids);
}

/**
 * Положить inbound в Redis-очередь wa:inbound. Используется как основной
 * путь обработки — освобождает Baileys event loop моментально.
 */
/**
 * Реальный телефон клиента из ключа сообщения (только цифры). Для WhatsApp-LID
 * чатов remoteJid это `<lid>@lid` (НЕ номер), а PN лежит в remoteJidAlt. Берём
 * ту из {remoteJid, remoteJidAlt}, что оканчивается на @s.whatsapp.net.
 */
function realPhoneFromKey(key: { remoteJid?: string | null; remoteJidAlt?: string | null }): string | undefined {
  for (const jid of [key.remoteJid, key.remoteJidAlt]) {
    if (jid && jid.endsWith("@s.whatsapp.net")) {
      // Отбрасываем суффикс устройства "<номер>:<device>"; строгая проверка цифр.
      const user = jid.slice(0, jid.indexOf("@")).split(":")[0] ?? "";
      if (/^\d{7,15}$/.test(user)) return user;
    }
  }
  return undefined;
}

async function enqueueInbound(
  agentId: string,
  chatId: string,
  senderName: string | undefined,
  senderPhone: string | undefined,
  message: string,
  waMessageId: string | undefined,
  workerSessionId: string,
  messageTimestamp: number | undefined,
  audioBase64?: string,
  audioMimeType?: string
): Promise<void> {
  const queue = getInboundQueue();
  // Inbound у нас приходит не из HTTP, поэтому request-id генерим тут.
  // Дальше он трассируется через jobs → outbound и попадает в логи всех сервисов.
  const requestId = `wa-${agentId.slice(-6)}-${randomUUID()}`;
  const payload: WaInboundJob = {
    agentId,
    chatId,
    message,
    workerSessionId,
    requestId,
    ...(senderName !== undefined ? { senderName } : {}),
    ...(senderPhone !== undefined ? { senderPhone } : {}),
    ...(waMessageId !== undefined ? { waMessageId } : {}),
    ...(messageTimestamp !== undefined ? { messageTimestamp } : {}),
    ...(audioBase64 !== undefined ? { audioBase64 } : {}),
    ...(audioMimeType !== undefined ? { audioMimeType } : {})
  };
  await queue.add("wa-inbound", payload, {
    // Тот же dedupe-ключ, что и в API endpoint /whatsapp/inbound/enqueue.
    ...(waMessageId ? { jobId: `wa:${agentId}:${waMessageId}` } : {})
  });
}

/**
 * Ручной ответ владельца, написанный со своего телефона. Кладём в ту же очередь
 * `wa:inbound` с флагом fromOwner — jobs запишет его как исходящую реплику, чтобы
 * бот видел весь разговор и не начинал его заново после паузы.
 */
async function enqueueOwnerOutbound(
  agentId: string,
  chatId: string,
  message: string,
  waMessageId: string | undefined,
  workerSessionId: string,
  messageTimestamp: number | undefined
): Promise<void> {
  const payload: WaInboundJob = {
    agentId,
    chatId,
    message,
    workerSessionId,
    fromOwner: true,
    requestId: `wa-own-${agentId.slice(-6)}-${randomUUID()}`,
    ...(waMessageId !== undefined ? { waMessageId } : {}),
    ...(messageTimestamp !== undefined ? { messageTimestamp } : {})
  };
  await getInboundQueue().add("wa-inbound", payload, {
    ...(waMessageId ? { jobId: `wa-own:${agentId}:${waMessageId}` } : {})
  });
}

/**
 * Ограничивает ожидание промиса. Нужен для socket.sendMessage: своего таймаута у
 * Baileys нет, и на «мёртвом, но не закрытом» сокете отправка может не завершиться
 * никогда — тогда навсегда залипает и per-chat лок, и сама задача BullMQ.
 *
 * Исходный промис не отменяем (это невозможно), но обработчик у него уже есть —
 * Promise.race, поэтому поздний reject не станет unhandled rejection.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: таймаут ${ms} мс`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Сколько id своих отправок держим на чат-соединение (страховка от эха). */
const SELF_SENT_IDS_LIMIT = 500;

function rememberSelfSent(connection: ManagedConnection, waMsgId: string | null | undefined): void {
  if (!waMsgId) return;
  if (connection.selfSentIds.size >= SELF_SENT_IDS_LIMIT) {
    // Set сохраняет порядок вставки — выкидываем самый старый id.
    const oldest = connection.selfSentIds.values().next().value;
    if (oldest) connection.selfSentIds.delete(oldest);
  }
  connection.selfSentIds.add(waMsgId);
}

/**
 * Legacy/fallback путь: если REDIS_URL не выставлен — стучимся напрямую
 * в API синхронно. Воркер ждёт ответ и сам отправляет reply в WhatsApp,
 * как раньше. Используется только в dev без поднятого Redis.
 */
async function sendInboundToApi(
  agentId: string,
  chatId: string,
  senderName: string | undefined,
  senderPhone: string | undefined,
  message: string,
  waMessageId: string | undefined,
  workerSessionId: string,
  messageTimestamp: number | undefined
) {
  const response = await fetch(new URL("/api/whatsapp/inbound", env.API_ORIGIN), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": env.API_INTERNAL_TOKEN,
      "x-worker-session": workerSessionId
    },
    body: JSON.stringify({
      agentId,
      chatId,
      senderName,
      senderPhone,
      message,
      waMessageId,
      messageTimestamp
    })
  });

  if (!response.ok) {
    throw new Error(`Inbound call failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as { reply?: string; summary?: string; leadId?: string | null };
}

export class ConnectionManager {
  private connections = new Map<string, ManagedConnection>();
  /** Чаты, где бот уже отправлял хотя бы один ответ (для read/typing диапазонов). */
  private repliedChats = new Set<string>();
  /** Сериализация send/humanize на один chatId. */
  private chatSendLocks = new Map<string, Promise<void>>();
  /**
   * Последнее непрочитанное входящее на чат (chatKey → ключ сообщения).
   * Прочтение (синие галочки) ставим НЕ сразу по приходу, а за ~5с до начала
   * ответа — см. onRead в sendUnlocked / waitWithTyping. Так бот выглядит
   * по-человечески: «открыл чат, прочитал, начал печатать».
   */
  private pendingReads = new Map<string, { waMsgId: string; participant?: string }>();

  private getConnection(agentId: string) {
    return this.connections.get(agentId);
  }

  private setConnection(agentId: string, next: ManagedConnection) {
    this.connections.set(agentId, next);
    return next;
  }

  private publicState(state: ManagedConnection): PublicConnectionState {
    return {
      status: state.status,
      qrText: state.qrText ?? null,
      qrDataUrl: state.qrDataUrl ?? null,
      phone: state.phone ?? null,
      workerSessionId: state.workerSessionId,
      lastSeenAt: state.lastSeenAt?.toISOString?.() ?? null
    };
  }

  private hasRepliedBefore(agentId: string, chatId: string): boolean {
    return this.repliedChats.has(chatKey(agentId, chatId));
  }

  private markReplied(agentId: string, chatId: string): void {
    this.repliedChats.add(chatKey(agentId, chatId));
  }

  /**
   * Ставит синие галочки «прочитано» на последнее входящее в чате.
   * Вызывается из onRead за ~5с до начала ответа (а не сразу по приходу),
   * чтобы выглядеть по-человечески. No-op, если читать нечего.
   */
  private async markChatRead(
    agentId: string,
    socket: NonNullable<ManagedConnection["socket"]>,
    chatId: string
  ): Promise<void> {
    const key = chatKey(agentId, chatId);
    const pending = this.pendingReads.get(key);
    if (!pending) return;
    this.pendingReads.delete(key);
    await socket
      .readMessages([
        {
          remoteJid: chatId,
          id: pending.waMsgId,
          fromMe: false,
          ...(pending.participant ? { participant: pending.participant } : {})
        }
      ])
      .catch(() => undefined);
  }

  async start(
    agentId: string,
    options: { fresh?: boolean; restart?: boolean; styleHistoryCapture?: boolean } = {}
  ): Promise<PublicConnectionState> {
    const existing = this.getConnection(agentId);
    // Согласие на захват истории «липкое»: явно переданный флаг обновляет его,
    // иначе сохраняем прежнее (внутренние рестарты зовут start без флага).
    const styleHistoryCapture = options.styleHistoryCapture ?? existing?.styleHistoryCapture ?? false;
    // restart=true ОБХОДИТ этот guard: после code 515 managed ещё «живой»
    // (status="pairing"/"connecting"), но сокет мёртв — нужно пересоздать
    // его с теми же creds, а не вернуть осиротевшее соединение.
    if (
      !options.fresh &&
      !options.restart &&
      existing &&
      !existing.stopRequested &&
      existing.status !== "disconnected"
    ) {
      return this.publicState(existing);
    }

    // Пересоздаём сокет — снимаем listeners со старого, чтобы его фоновые
    // эвенты (или поздний close после 515) не дёргали обновлённый managed.
    if (existing?.socket) {
      try {
        existing.socket.ev.removeAllListeners?.("connection.update");
        existing.socket.ev.removeAllListeners?.("creds.update");
        existing.socket.ev.removeAllListeners?.("messages.upsert");
      } catch {
        // no-op
      }
    }

    const { state, saveCreds } = await useDbAuthState(agentId, { fresh: options.fresh ?? false });
    const version = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      version: version.version,
      auth: state,
      printQRInTerminal: false,
      // ВАЖНО: только СТАНДАРТНЫЙ browser-tuple. Кастомный массив
      // (["app.jazu.chat", "Chrome", "Ubuntu"]) ломал привязку — WhatsApp
      // переставал доводить pairing до pair-success (см. Baileys issue #2306:
      // "pairing code generated but not received as notification"; фикс —
      // вернуться на Browsers.ubuntu('Chrome')). Красивое имя устройства в
      // Linked Devices не стоит сломанной привязки.
      browser: Browsers.ubuntu("Chrome"),
      // НЕ держим бота «в сети» постоянно. По умолчанию Baileys шлёт presence
      // "available" сразу после коннекта и держит онлайн всё время — выглядит
      // не по-человечески. Вместо этого появляемся в сети только на время
      // ответа клиенту (см. waitWithTyping/stopTyping в humanize-reply.ts).
      markOnlineOnConnect: false,
      // Запрашиваем максимально полную историю чатов при привязке. Нужно для
      // pre-connection snapshot: чем полнее history-sync, тем больше старых
      // чатов мы пометим как «до-коннектные» и бот в них не полезет.
      syncFullHistory: true
    });

    const existingAttempts = this.connections.get(agentId)?.reconnectAttempts ?? 0;
    const managed: ManagedConnection = this.setConnection(agentId, {
      agentId,
      socket,
      status: "pairing",
      qrText: null,
      qrDataUrl: null,
      phone: null,
      workerSessionId: randomUUID(),
      lastSeenAt: new Date(),
      stopRequested: false,
      lastSentAt: existing?.lastSentAt ?? new Map<string, number>(),
      selfSentIds: existing?.selfSentIds ?? new Set<string>(),
      reconnectAttempts: existingAttempts,
      styleHistoryCapture,
      pairingMode: existing?.pairingMode ?? false,
      pairingCode: existing?.pairingCode ?? null,
      pairingCodeIssuedAt: existing?.pairingCodeIssuedAt ?? 0,
      pairingPhone: existing?.pairingPhone ?? null
    });

    socket.ev.on("creds.update", saveCreds);

    // history-sync: снимок чатов, существовавших ДО подключения. Шлём их в
    // API — там они станут «до-коннектными» (бот в них молчит). API сам
    // отфильтрует по окну свежей привязки, поэтому при reconnect старой
    // сессии чаты, которые бот уже ведёт, НЕ будут помечены.
    socket.ev.on("messaging-history.set", (payload) => {
      if (managed.stopRequested) return;
      const chatIds = collectHistoryChatIds(payload);
      void pushPreConnectionChats(agentId, chatIds);
      // Фича «бот в стиле владельца»: буферизуем текст личных диалогов для анализа
      // (только при согласии — глобальный ENV ИЛИ per-agent флаг из UI). Личную
      // переписку без явного согласия не собираем.
      const capture = env.WA_STYLE_HISTORY_CAPTURE || managed.styleHistoryCapture;
      if (capture) {
        const dialogues = collectHistoryDialogues(payload);
        void pushHistoryDialogues(agentId, dialogues);
        // Прогресс синка для статус-бара. ВАЖНО: НЕ завершаем по isLatest — его
        // несут и статусные/именные чанки (INITIAL_STATUS_V3, PUSH_NAME), которые
        // приходят раньше реальных сообщений (RECENT/FULL). Если закрыть синк на
        // них, бар покажет «готово, 0 чатов», хотя переписка ещё в пути. Поэтому
        // завершаем по «тишине»: если новых чанков нет HISTORY_QUIET_MS — done.
        // Сам захват при этом продолжает работать и для поздних чанков (флаг живёт).
        const progress = typeof payload.progress === "number" ? payload.progress : null;
        void pushHistoryProgress(agentId, { progress, status: "syncing" });
        if (managed.historySyncTimer) clearTimeout(managed.historySyncTimer);
        managed.historySyncTimer = setTimeout(() => {
          void pushHistoryProgress(agentId, { progress: 100, status: "done" });
        }, HISTORY_QUIET_MS);
      }
    });

    socket.ev.on("connection.update", async (update) => {
      if (managed.stopRequested) {
        return;
      }

      if (update.qr) {
        // В pairing-code режиме Baileys всё равно эмитит QR (запрос идёт
        // параллельно); игнорим его, чтобы UI не показывал QR вместо кода.
        if (managed.pairingMode) {
          managed.lastSeenAt = new Date();
        } else {
          managed.status = "qr";
          managed.qrText = update.qr;
          managed.qrDataUrl = await QRCode.toDataURL(update.qr);
          managed.lastSeenAt = new Date();
          void pushStatusToApi(agentId, {
            status: "qr",
            qrText: managed.qrText,
            qrDataUrl: managed.qrDataUrl,
            workerSessionId: managed.workerSessionId
          });
        }
      }

      if (update.connection === "open") {
        // Анти-абуз: атомарно «застолбить» номер за владельцем агента.
        // Делаем ДО того как пометим себя connected — иначе юзер увидит
        // «Подключено» на долю секунды, а потом «Этот номер уже занят».
        const phoneDigits = extractPhoneFromJid(socket.user?.id);
        if (phoneDigits) {
          void (async () => {
            const claim = await claimWaPhone(agentId, phoneDigits);
            if (!claim.ok && !claim.networkError) {
              // Чужой номер — рвём всё. wipeAuthState критичен, иначе при
              // следующем start() Baileys поднимет creds и опять привяжется
              // (мы же не отозвали pairing на стороне WA — мы просто отказали).
              console.warn(
                `[wa-claim] rejecting agent=${agentId} reason=${claim.reason}: ${claim.message}`
              );
              try {
                socket.ev.removeAllListeners?.("connection.update");
                socket.ev.removeAllListeners?.("creds.update");
                socket.ev.removeAllListeners?.("messages.upsert");
                const sockAny = socket as unknown as {
                  ws?: { close?: () => void };
                  end?: (err?: Error) => void;
                };
                sockAny.end?.(new Error("claim rejected"));
                sockAny.ws?.close?.();
              } catch {
                // no-op
              }
              managed.status = "error";
              managed.qrText = claim.message ?? "Этот номер уже привязан к другому аккаунту.";
              managed.qrDataUrl = null;
              managed.phone = null;
              managed.pairingMode = false;
              managed.pairingCode = null;
              this.connections.delete(agentId);
              await wipeAuthStateInDb(agentId).catch(() => undefined);
              void pushStatusToApi(agentId, {
                status: "error",
                qrText: managed.qrText,
                qrDataUrl: null,
                phone: null,
                workerSessionId: managed.workerSessionId
              });
              return;
            }
            // Claim OK (или networkError — claim создастся при следующем
            // reconnect). Помечаем connected как обычно.
            //
            // botRespondsSince: фиксируем «бот отвечает только на сообщения
            // и чаты ПОСЛЕ этого момента». Защита от history-sync flood
            // (WhatsApp при connection шлёт пачку старых непрочитанных) и
            // от вторжения бота в старые чаты юзера.
            managed.status = "connected";
            managed.qrText = null;
            managed.qrDataUrl = null;
            managed.phone = `+${phoneDigits}`;
            managed.lastSeenAt = new Date();
            managed.pairingMode = false;
            managed.pairingCode = null;
            void pushStatusToApi(agentId, {
              status: "connected",
              phone: managed.phone,
              qrText: null,
              workerSessionId: managed.workerSessionId,
              botRespondsSince: new Date().toISOString()
            });
          })();
        } else {
          // Не смогли распарсить номер — это аномалия Baileys. Лучше
          // не блокировать юзера, идём по обычному пути.
          managed.status = "connected";
          managed.qrText = null;
          managed.qrDataUrl = null;
          managed.phone = socket.user?.id ?? managed.phone ?? null;
          managed.lastSeenAt = new Date();
          managed.pairingMode = false;
          managed.pairingCode = null;
          void pushStatusToApi(agentId, {
            status: "connected",
            phone: managed.phone,
            qrText: null,
            workerSessionId: managed.workerSessionId,
            botRespondsSince: new Date().toISOString()
          });
        }
      }

      if (update.connection === "close") {
        const reasonCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        managed.lastSeenAt = new Date();

        // КРИТИЧНО: code 515 (restartRequired) — это НЕ ошибка. WhatsApp
        // присылает его сразу после успешного pairing ("pairing configured
        // successfully, expect to restart the connection"). Это инструкция
        // «закрой сокет, открой новый с теми же creds — и заходи как
        // зарегистрированное устройство». На это надо реагировать НЕМЕДЛЕННО
        // и без exponential backoff. Если не успеть в 1-2 секунды, WhatsApp
        // ставит cooldown и следующие коннекты молча отбивает с
        // Connection Failure.
        if (reasonCode === DisconnectReason.restartRequired) {
          // НЕ выставляем status=disconnected — это всё ещё «pairing in
          // progress». Иначе UI скажет «отключено» в момент завершения
          // привязки.
          managed.reconnectAttempts = 0;
          if (managed.reconnectTimer) {
            clearTimeout(managed.reconnectTimer);
          }
          // setImmediate, а не setTimeout(0), чтобы дать saveCreds() добежать
          // в текущем тике event loop.
          // restart=true КРИТИЧНО: иначе guard в start() увидит managed со
          // статусом не-disconnected и вернёт мёртвое соединение, не пересоздав
          // сокет — reconnect не случится, WhatsApp по таймауту инвалидирует
          // линк, телефон покажет «не удалось».
          setImmediate(() => {
            void this.start(agentId, { restart: true }).catch((err: unknown) => {
              console.error("[wa] post-515 restart failed:", err);
            });
          });
          return;
        }

        managed.status = "disconnected";
        void pushStatusToApi(agentId, { status: "disconnected", qrText: null, workerSessionId: managed.workerSessionId });

        if (reasonCode !== DisconnectReason.loggedOut && !managed.stopRequested) {
          if (managed.reconnectTimer) {
            clearTimeout(managed.reconnectTimer);
          }

          const MAX_ATTEMPTS = 5;
          managed.reconnectAttempts += 1;
          if (managed.reconnectAttempts <= MAX_ATTEMPTS) {
            // Exponential backoff: 5s, 10s, 20s, 40s, 60s
            const delay = Math.min(5000 * Math.pow(2, managed.reconnectAttempts - 1), 60000);
            managed.reconnectTimer = setTimeout(() => {
              void this.start(agentId);
            }, delay);
          }
        } else if (reasonCode === DisconnectReason.loggedOut) {
          managed.reconnectAttempts = 0;
        }
      }
    });

    socket.ev.on("messages.upsert", async (payload: { type: string; messages: WAMessageLike[] }) => {
      if (payload.type !== "notify") {
        return;
      }

      for (const message of payload.messages) {
        if (message.key.fromMe) {
          // Владелец ответил клиенту сам, со своего телефона. Пишем такую реплику
          // в диалог: без неё бот не видит половину разговора и, вернувшись с
          // паузы, здоровается заново поверх живой переписки.
          //
          // Свои же отправки сюда НЕ попадают: Baileys помечает их типом "append"
          // (messages-send), а мы обрабатываем только "notify". selfSentIds —
          // вторая линия защиты на случай эха.
          const ownChatId = message.key.remoteJid;
          const ownText = getTextMessage(message);
          const ownMsgId = message.key.id ?? undefined;
          if (
            !env.REDIS_URL
            || !ownChatId
            || !ownText
            || !isPersonalJid(ownChatId)
            || (ownMsgId && managed.selfSentIds.has(ownMsgId))
          ) {
            continue;
          }
          try {
            await enqueueOwnerOutbound(
              agentId,
              ownChatId,
              ownText,
              ownMsgId,
              managed.workerSessionId,
              extractMessageTimestamp(message.messageTimestamp)
            );
          } catch (err) {
            console.error(
              "Failed to enqueue owner outbound:",
              err instanceof Error ? err.message : err
            );
          }
          continue;
        }

        const text = getTextMessage(message);
        // Нет текста — пробуем голосовое/аудио. Скачиваем байты тут (в воркере
        // есть сокет), а распознавание делает wa-pipeline уже после dedupe.
        let voiceAudio: { base64: string; mimeType: string } | null = null;
        if (!text) {
          voiceAudio = await downloadVoiceAudio(message);
          if (!voiceAudio) {
            continue;
          }
        }

        const chatId = message.key.remoteJid;
        if (!chatId) {
          continue;
        }

        const senderName = message.pushName || undefined;
        // Реальный номер клиента (для @lid-чатов chatId им не является).
        const senderPhone = realPhoneFromKey(message.key);
        const waMsgId = message.key.id ?? undefined;
        const participant = message.key.participant ?? undefined;
        const messageTimestamp = extractMessageTimestamp(message.messageTimestamp);

        // Не читаем сразу. Запоминаем последнее входящее — прочитаем его за
        // ~5с до начала ответа (см. sendUnlocked → onRead).
        if (env.WA_HUMANIZE_REPLIES && waMsgId) {
          this.pendingReads.set(chatKey(agentId, chatId), {
            waMsgId,
            ...(participant ? { participant } : {})
          });
        }

        // Production path: enqueue в Redis. Ответ прилетит обратно через
        // wa:outbound и его отправит outboundWorker (другой consumer ниже).
        // Baileys event loop не блокируется ни на LLM, ни на DB.
        if (env.REDIS_URL) {
          try {
            await enqueueInbound(
              agentId,
              chatId,
              senderName,
              senderPhone,
              text ?? "",
              waMsgId,
              managed.workerSessionId,
              messageTimestamp,
              voiceAudio?.base64,
              voiceAudio?.mimeType
            );
            continue;
          } catch (err) {
            console.error(
              "Failed to enqueue inbound, falling back to sync HTTP:",
              err instanceof Error ? err.message : err
            );
          }
        }

        // Legacy fallback (dev без Redis или после ошибки enqueue).
        // Внимание: блокирует Baileys event loop — для нагрузки не годится.
        // Голосовые в legacy-пути не поддержаны (там нет STT) — пропускаем.
        if (!text) {
          console.warn("Voice message received but Redis is off — skipping (legacy path has no STT)");
          continue;
        }
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const result = await sendInboundToApi(
              agentId,
              chatId,
              senderName,
              senderPhone,
              text,
              waMsgId,
              managed.workerSessionId,
              messageTimestamp
            );
            if (result.reply) {
              const inboundReceivedAtMs =
                messageTimestamp !== undefined ? messageTimestamp * 1000 : Date.now();
              const isFirstBotReply = !this.hasRepliedBefore(agentId, chatId);
              const targetReplyAtMs = computeTargetReplyAtMs(inboundReceivedAtMs, isFirstBotReply);
              await this.send(agentId, {
                chatId,
                text: result.reply,
                ...(env.WA_HUMANIZE_REPLIES
                  ? { humanize: { targetReplyAtMs, isFirstBotReply } }
                  : {})
              });
            }
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
          }
        }
        if (lastError) {
          console.error("Inbound processing failed after retries:", lastError instanceof Error ? lastError.message : lastError);
        }
      }
    });

    return this.publicState(managed);
  }

  // Часть публичного API менеджера — Fastify handler'ы ждут Promise.
  // Тело синхронное, но сигнатуру оставляем async, чтобы throw'ы автоматически
  // становились rejected promise'ами (а не выкидывались синхронно).
  async stop(agentId: string): Promise<PublicConnectionState> {
    const connection = this.getConnection(agentId);
    if (!connection) {
      return { status: "disconnected" };
    }

    connection.stopRequested = true;
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
    }
    if (connection.historySyncTimer) {
      clearTimeout(connection.historySyncTimer);
    }

    // ВАЖНО: НЕ зовём socket.logout() — он пытается talk-to-WA-server и
    // может зависнуть/сохранить partial creds. Просто закрываем WebSocket
    // и снимаем все listeners, чтобы фоновые ивенты не реанимировали стейт.
    try {
      connection.socket?.ev?.removeAllListeners?.("connection.update");
      connection.socket?.ev?.removeAllListeners?.("creds.update");
      connection.socket?.ev?.removeAllListeners?.("messages.upsert");
    } catch {
      // no-op
    }
    try {
      const sockAny = connection.socket as unknown as {
        ws?: { close?: () => void; readyState?: number };
        end?: (err?: Error) => void;
      } | undefined;
      sockAny?.end?.(new Error("manual stop"));
      sockAny?.ws?.close?.();
    } catch {
      // no-op
    }
    (connection as { socket?: unknown }).socket = undefined;

    connection.status = "disconnected";
    connection.qrText = null;
    connection.qrDataUrl = null;
    connection.phone = null;
    connection.lastSeenAt = new Date();
    connection.pairingMode = false;
    connection.pairingCode = null;
    connection.pairingPhone = null;

    this.connections.delete(agentId);
    return this.publicState(connection);
  }

  async status(agentId: string): Promise<PublicConnectionState> {
    const connection = this.getConnection(agentId);
    if (!connection) {
      return { status: "disconnected" };
    }

    return this.publicState(connection);
  }

  /**
   * Запросить у WhatsApp 8-значный pairing code для указанного номера.
   * Альтернатива QR: пользователь вводит код в WhatsApp → Linked Devices →
   * Link with phone number instead.
   *
   * Требования Baileys:
   *  - сокет должен быть создан (start() уже вызван);
   *  - аккаунт ещё не зарегистрирован (creds.registered === false).
   *    Если связь уже стоит — pairing code запрашивать нельзя, нужно сначала stop().
   */
  async pair(
    agentId: string,
    phoneDigits: string,
    options: { styleHistoryCapture?: boolean } = {}
  ): Promise<{ code: string; phone: string }> {
    let connection = this.getConnection(agentId);

    // Уже подключено — pairing не нужен.
    if (connection?.status === "connected") {
      throw new Error("Уже подключено. Чтобы перепривязать номер, сначала отвяжите текущий.");
    }

    // ── Идемпотентность 1: если код уже выдан для этого номера и не истёк —
    // возвращаем тот же. Защищает от двойных кликов и React-страйт-моде.
    if (
      connection?.pairingCode &&
      connection.pairingPhone === phoneDigits &&
      connection.pairingCodeIssuedAt &&
      Date.now() - connection.pairingCodeIssuedAt < PAIRING_CODE_TTL_MS
    ) {
      return { code: connection.pairingCode, phone: `+${phoneDigits}` };
    }

    // ВСЕГДА начинаем pairing с чистого листа: гасим текущий сокет (если есть)
    // и поднимаем заново с fresh=true. Это убирает баг "passive=true login"
    // когда Baileys цепляет старые creds из БД и WhatsApp отбивает с
    // "Connection Failure" ещё до выдачи кода.
    if (connection?.socket || connection?.pairingCode) {
      await this.stop(agentId);
    }

    // КРИТИЧНО: при ЛЮБОМ повторном паринге (новый номер, истёкший код,
    // ретрай после «телефон затупил») чистим authState в БД ДО start().
    // Иначе:
    //   - предыдущий запрос мог записать partial creds (me/noiseKey без
    //     registered=true). При новом start() Baileys их подцепит и попытается
    //     зайти как passive=true — WhatsApp молча отбивает соединение, новый
    //     pairing code тоже отлетает как «неверный»;
    //   - WhatsApp на стороне сервера держит одну активную pairing-сессию на
    //     устройство. Чистый authState заставляет Baileys сгенерить новые
    //     ключи устройства, и WhatsApp выдаст реально работающий код.
    await wipeAuthStateInDb(agentId).catch(() => undefined);

    // Прокидываем согласие на захват истории: pairing-code — это свежая привязка,
    // при которой WhatsApp пришлёт history-sync (как и QR), поэтому флаг нужен.
    await this.start(agentId, {
      fresh: true,
      ...(options.styleHistoryCapture !== undefined
        ? { styleHistoryCapture: options.styleHistoryCapture }
        : {})
    });
    connection = this.getConnection(agentId);
    if (!connection?.socket) {
      throw new Error("Не удалось инициализировать WhatsApp-сокет");
    }

    // Включаем pairing-mode ДО запроса кода — чтобы QR-эвенты от Baileys
    // не перетёрли статус на "qr" (Baileys всё равно их эмитит параллельно).
    connection.pairingMode = true;
    connection.status = "pairing";
    connection.qrText = null;
    connection.qrDataUrl = null;
    connection.pairingPhone = phoneDigits;

    // КРИТИЧНО: WhatsApp принимает pairing code только если сокет успел
    // завершить noise-handshake. Признак — первый `qr` event от Baileys.
    // На "connecting" (просто ws.open) sendNode внутри requestPairingCode
    // отвалится и порвёт соединение.
    try {
      await waitForSocketReady(connection.socket, 15000);
    } catch (err) {
      console.error("[pair] socket not ready:", err instanceof Error ? err.message : err);
      connection.pairingMode = false;
      await this.stop(agentId).catch(() => undefined);
      await wipeAuthStateInDb(agentId).catch(() => undefined);
      throw new Error(err instanceof Error ? err.message : "WhatsApp недоступен", { cause: err });
    }

    let raw: string;
    try {
      raw = await connection.socket.requestPairingCode(phoneDigits);
    } catch (err) {
      console.error("[pair] requestPairingCode failed:", err instanceof Error ? err.stack ?? err.message : err);
      // Если Baileys ругнулся — гасим сокет И чистим auth-state в БД,
      // потому что Baileys мог уже записать partial creds (me без registered),
      // которые при следующем старте уйдут в passive=true login и отобьются.
      connection.pairingMode = false;
      await this.stop(agentId).catch(() => undefined);
      await wipeAuthStateInDb(agentId).catch(() => undefined);
      const message = err instanceof Error ? err.message : "WhatsApp отказал в выдаче кода";
      throw new Error(message, { cause: err });
    }

    const normalized = raw.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const code = normalized.length === 8
      ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
      : raw;

    connection.pairingCode = code;
    connection.pairingCodeIssuedAt = Date.now();
    connection.phone = `+${phoneDigits}`;
    connection.lastSeenAt = new Date();

    void pushStatusToApi(agentId, {
      status: "pairing",
      qrText: null,
      qrDataUrl: null,
      phone: connection.phone,
      workerSessionId: connection.workerSessionId
    });

    return { code, phone: `+${phoneDigits}` };
  }

  async send(
    agentId: string,
    payload: {
      chatId: string;
      text: string;
      texts?: string[];
      humanize?: { targetReplyAtMs: number; isFirstBotReply: boolean };
      /** С какого пузыря продолжать (докачка после обрыва). По умолчанию с нуля. */
      startIndex?: number;
      /** Вызывается после каждого доставленного пузыря — consumer пишет прогресс. */
      onBubbleSent?: (sentCount: number) => Promise<void>;
    }
  ): Promise<void> {
    const lockKey = chatKey(agentId, payload.chatId);
    const prev = this.chatSendLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(() => gate);
    this.chatSendLocks.set(lockKey, chain);

    await prev;
    try {
      await this.sendUnlocked(agentId, payload);
    } finally {
      release();
      if (this.chatSendLocks.get(lockKey) === chain) {
        this.chatSendLocks.delete(lockKey);
      }
    }
  }

  private async sendUnlocked(
    agentId: string,
    payload: {
      chatId: string;
      text: string;
      texts?: string[];
      humanize?: { targetReplyAtMs: number; isFirstBotReply: boolean };
      startIndex?: number;
      onBubbleSent?: (sentCount: number) => Promise<void>;
    }
  ): Promise<void> {
    const connection = this.getConnection(agentId);
    if (!connection?.socket) {
      throw new Error("Connection is not active");
    }
    const socket = connection.socket;
    const chatId = payload.chatId;

    // Мультисообщения: список пузырей (или один текст). Пустые отбрасываем.
    const bubbles = (payload.texts && payload.texts.length > 0 ? payload.texts : [payload.text])
      .map((t) => (t ?? "").trim())
      .filter((t) => t.length > 0);
    if (bubbles.length === 0) return;

    // Докачка после обрыва: пузыри до startIndex клиент уже получил, повторять их
    // нельзя. Если доставлено всё — задача идемпотентно завершается пустой.
    const startIndex = Math.max(0, payload.startIndex ?? 0);
    if (startIndex >= bubbles.length) return;

    // Полную «человеческую» задержку выдерживаем только на первом заходе: на
    // докачке клиент уже получил начало ответа и ждёт продолжения — тянуть ещё
    // минуту молчания неправильно.
    if (env.WA_HUMANIZE_REPLIES && payload.humanize && startIndex === 0) {
      await waitWithTyping(
        socket,
        chatId,
        payload.humanize.targetReplyAtMs,
        payload.humanize.isFirstBotReply,
        humanizeTimingConfig(),
        {
          // Прочитать входящее за ~5с до начала «печатает…».
          readLeadMs: randomInt(env.WA_READ_LEAD_MIN_MS, env.WA_READ_LEAD_MAX_MS),
          onRead: () => this.markChatRead(agentId, socket, chatId)
        }
      );
    }

    // Простой per-chatId rate-limit: не чаще одного сообщения за заданный
    // интервал (по умолчанию 1.2с). WhatsApp банит ботов за бурсты —
    // это первый ад-хок защитный слой; масштабный rate-limit на стороне
    // outbound-консьюмера в bullmq (см. handlers/wa-outbound.ts).
    const MIN_INTERVAL_MS = env.WA_PER_CHAT_MIN_INTERVAL_MS;
    const rateLimit = async () => {
      const last = connection.lastSentAt.get(chatId) ?? 0;
      const wait = MIN_INTERVAL_MS - (Date.now() - last);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    };

    for (let i = startIndex; i < bubbles.length; i++) {
      // Между пузырями — пауза «печатает…» пропорционально длине следующего.
      if (i > 0 && env.WA_HUMANIZE_REPLIES) {
        await typeBubblePause(socket, chatId, computeBubblePauseMs(bubbles[i]!));
      }
      await rateLimit();
      const sent = await withTimeout(
        socket.sendMessage(chatId, { text: bubbles[i]! }),
        env.WA_SEND_TIMEOUT_MS,
        `sendMessage(${chatId}) пузырь ${i + 1}/${bubbles.length}`
      );
      rememberSelfSent(connection, sent?.key?.id);
      connection.lastSentAt.set(chatId, Date.now());
      // Фиксируем прогресс СРАЗУ после доставки: если следующий пузырь упадёт,
      // ретрай продолжит с него, а не отправит клиенту начало ответа заново.
      await payload.onBubbleSent?.(i + 1);
    }

    await stopTyping(socket, chatId);
    connection.lastSeenAt = new Date();
    this.markReplied(agentId, chatId);
  }

  /**
   * Graceful shutdown всех активных Baileys-сокетов. Не пушит logout —
   * только закрывает WebSocket, чтобы не повредить creds в БД. После этого
   * следующий старт worker'а корректно восстановит сессии через
   * resumeActiveConnections() (см. index.ts).
   */
  async shutdown(): Promise<void> {
    const agentIds = Array.from(this.connections.keys());
    for (const agentId of agentIds) {
      try {
        await this.stop(agentId);
      } catch {
        // best-effort — на shutdown ошибки игнорируем
      }
    }
  }
}
