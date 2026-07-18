// Парсер источников диалогов в единый формат DialogueEpisode[].
// Поддерживает два входа:
//   1. .txt-экспорт WhatsApp («Экспорт чата» с телефона) — iOS и Android, RU/US-локали;
//   2. JSON от WhatsApp-Chat-Exporter (wtsexporter) — массовая выгрузка всей базы.
// Общее: определение владельца, склейка многострочных сообщений, разрез на эпизоды
// по паузе, маскирование телефонов. LLM/сеть здесь НЕ используются.

import type { DialogueEpisode, DialogueTurn } from "./types.js";

/** По умолчанию новый эпизод, если пауза между сообщениями больше стольких дней. */
export const DEFAULT_EPISODE_SPLIT_DAYS = 3;

export type ParseOptions = {
  /**
   * Как владелец подписан в чатах: имя контакта на телефоне ИЛИ его номер (цифры).
   * Для .txt это единственный способ отличить владельца от клиента. Для JSON
   * приоритетно используется флаг from_me, ownerName — только фолбэк.
   */
  ownerName?: string;
  /** Ярлык чата (имя файла/контакта). Будет замаскирован. */
  chatLabel?: string;
  /** Порог разрыва для нового эпизода (дни). */
  splitDays?: number;
};

// Плейсхолдеры медиа/системных строк WhatsApp в разных локалях — не текст диалога.
const MEDIA_PLACEHOLDER_RE =
  /^(?:‎)?(?:<Media omitted>|<Медиафайл пропущен>|image omitted|video omitted|audio omitted|sticker omitted|GIF omitted|document omitted|Contact card omitted|изображение отсутствует|видео отсутствует|аудио отсутствует|наклейка отсутствует|GIF отсутствует|документ отсутствует|это сообщение удалено|this message was deleted|you deleted this message|null)$/i;

// Системные уведомления без отправителя (шифрование, смена номера, звонки).
// Формулировки узкие, чтобы не задеть живые реплики (клиент может написать
// «я сменил номер, запишите новый» — это НЕ системное уведомление).
const SYSTEM_NOTICE_RE =
  /(?:end-to-end encrypted|end-to-end зашифрован|messages and calls are|сообщения и звонки защищены|защищены сквозным шифрованием|changed to a new phone number|сменил[а]? номер телефона|created group|создал[а]? группу|added you|добавил[а]? вас в группу|left$|вышел$|missed voice call|missed video call|пропущенный (?:голосовой|видео))/i;

/**
 * Заголовок сообщения: [дата, время] или дата, время -  с последующим "Отправитель: тело".
 * Возвращает { date, sender, body } либо null (строка — продолжение предыдущего сообщения).
 * Системные строки (нет "Отправитель:") дают sender=null.
 */
type Header = { date: Date | undefined; sender: string | null; body: string };

const BRACKET_RE = /^\u200e?\u200f?\[([^\]]+)\]\s*([\s\S]*)$/;
const DASH_RE = /^\u200e?\u200f?([\d].*?\d(?:\s*[APap][Mm])?)\s-\s([\s\S]*)$/;

function parseTimestamp(raw: string): Date | undefined {
  // Форматы даты: dd.mm.yyyy | dd/mm/yy | m/d/yy ; время: HH:mm[:ss] [AM/PM]
  const m = raw
    .trim()
    .match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?$/);
  if (!m) return undefined;
  const [, p1, p2, y, hh, mm, ss, ap] = m;
  let day = Number(p1);
  let month = Number(p2);
  // US-локаль: m/d/yy при "/" разделителе, если первое число похоже на месяц.
  if (raw.includes("/") && Number(p1) <= 12 && Number(p2) > 12) {
    month = Number(p1);
    day = Number(p2);
  }
  let year = Number(y);
  if (year < 100) year += 2000;
  let hour = Number(hh);
  const minute = Number(mm);
  const second = ss ? Number(ss) : 0;
  if (ap) {
    const upper = ap.toUpperCase();
    if (upper === "PM" && hour < 12) hour += 12;
    if (upper === "AM" && hour === 12) hour = 0;
  }
  const d = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function splitSenderBody(rest: string): { sender: string | null; body: string } {
  // "Отправитель: тело" — отправитель без переводов строк и не длиннее разумного.
  const idx = rest.indexOf(":");
  if (idx > 0 && idx <= 80) {
    const sender = rest.slice(0, idx).trim();
    const body = rest.slice(idx + 1).replace(/^\s/, "");
    if (sender && !sender.includes("\n")) {
      return { sender, body };
    }
  }
  return { sender: null, body: rest };
}

function parseHeader(line: string): Header | null {
  const bracket = line.match(BRACKET_RE);
  if (bracket) {
    const date = parseTimestamp(bracket[1] ?? "");
    if (!date) return null; // [что-то] но не дата — не заголовок
    const { sender, body } = splitSenderBody(bracket[2] ?? "");
    return { date, sender, body };
  }
  const dash = line.match(DASH_RE);
  if (dash) {
    const date = parseTimestamp(dash[1] ?? "");
    if (!date) return null;
    const { sender, body } = splitSenderBody(dash[2] ?? "");
    return { date, sender, body };
  }
  return null;
}

/**
 * Маскирует телефонные номера в тексте на «[номер]». Имена маскирует LLM позже.
 * Осторожно с ложными срабатываниями: цены с разрядами («5 000 000 тенге») и
 * перечисления коротких чисел («42 44 46 48») телефонами НЕ считаются.
 */
export function maskPhones(text: string): string {
  // Кандидаты: 8+ символов из цифр/скобок/дефисов/пробелов, 7-15 цифр внутри.
  return text.replace(/\+?\d[\d()\-\s]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return m;
    // Явные признаки телефона: «+», скобки или дефисы (+7 999 123-45-67, +1 (415) 555-2671).
    if (m.includes("+") || /[()-]/.test(m)) return "[номер]";
    // Число с разрядами по три — цена/сумма («5 000 000»), не телефон.
    if (/^\d{1,3}(?:\s\d{3})+$/.test(m)) return m;
    // Слитные цифры: телефон от 10 знаков (87001234567); короче — цена/артикул.
    if (/^\d+$/.test(m)) return digits.length >= 10 ? "[номер]" : m;
    // Пробельные группы: телефоноподобно при 10-12 цифрах и немногих группах
    // (8 700 123 45 67); перечисления коротких чисел («42 44 46 48 50 52») — нет.
    const groups = m.split(/\s+/);
    const phoneLike =
      digits.length >= 10 && digits.length <= 12 && groups.length <= 5 && groups.some((g) => g.length >= 3);
    return phoneLike ? "[номер]" : m;
  });
}

/** Убирает служебные unicode-маркеры направления письма из строки. */
function stripMarks(text: string): string {
  return text.replace(/[\u200e\u200f\u202a-\u202e]/g, "");
}

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Разбивает имя на слова-токены (для сравнения по целым словам, а не подстрокам). */
function nameTokens(value: string): string[] {
  return value.trim().toLowerCase().split(/[\s,.;:()\-–—]+/).filter(Boolean);
}

/**
 * Матч отправителя с «владельцем»: по имени (целыми словами, регистронезависимо)
 * или по цифрам номера. Подстрочный матч запрещён: «Али» не должен матчить «Галия».
 */
function isOwnerSender(sender: string, ownerName?: string): boolean {
  if (!ownerName) return false;
  const s = sender.trim().toLowerCase();
  const o = ownerName.trim().toLowerCase();
  if (s === o) return true;
  // Все слова более короткого имени должны присутствовать как ЦЕЛЫЕ слова в другом
  // («Ильяс» ↔ «Ильяс Барбер», но не «Али» ↔ «Галия»).
  const sTokens = nameTokens(sender);
  const oTokens = nameTokens(ownerName);
  if (sTokens.length > 0 && oTokens.length > 0) {
    const [shorter, longer] =
      sTokens.length <= oTokens.length ? [sTokens, oTokens] : [oTokens, sTokens];
    if (shorter.every((t) => longer.includes(t))) return true;
  }
  const sDigits = normalizeDigits(sender);
  const oDigits = normalizeDigits(ownerName);
  return oDigits.length >= 7 && sDigits.length >= 7 && (sDigits.endsWith(oDigits) || oDigits.endsWith(sDigits));
}

type RawMessage = { sender: string; body: string; date: Date | undefined };

/**
 * Хронологическая сортировка: сообщениям без даты присваиваем время предыдущего
 * датированного (carry-forward), чтобы они не улетали в начало потока, а stable sort
 * сохранял их рядом с соседями по исходному порядку.
 */
function sortChronologically(messages: RawMessage[]): RawMessage[] {
  let lastTs = 0;
  const keyed = messages.map((m) => {
    if (m.date) lastTs = m.date.getTime();
    return { m, ts: lastTs };
  });
  return keyed.sort((a, b) => a.ts - b.ts).map((k) => k.m);
}

function collectRawMessages(content: string): RawMessage[] {
  const lines = content.split(/\r?\n/);
  const messages: RawMessage[] = [];
  let current: RawMessage | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.body.trim();
    if (
      body &&
      !MEDIA_PLACEHOLDER_RE.test(stripMarks(body)) &&
      !SYSTEM_NOTICE_RE.test(body)
    ) {
      messages.push({ ...current, body });
    }
    current = null;
  };

  for (const line of lines) {
    const header = parseHeader(line);
    if (header) {
      flush();
      if (header.sender === null) {
        // Системная запись с датой (шифрование и т.п.) — обрывает продолжение, но не сообщение.
        current = null;
        continue;
      }
      current = { sender: header.sender, body: header.body, date: header.date };
    } else if (current) {
      // Продолжение многострочного сообщения.
      current.body += `\n${line}`;
    }
    // Строка без заголовка и без текущего сообщения (шапка файла) — игнор.
  }
  flush();
  return messages;
}

/** Разрезает поток сообщений на эпизоды по паузе > splitDays. */
function splitEpisodes(
  messages: RawMessage[],
  ownerName: string | undefined,
  chatLabel: string,
  splitDays: number
): DialogueEpisode[] {
  const episodes: DialogueEpisode[] = [];
  const gapMs = splitDays * 24 * 60 * 60 * 1000;
  let bucket: RawMessage[] = [];
  let prevDate: Date | undefined;

  const commit = () => {
    if (bucket.length === 0) return;
    const turns: DialogueTurn[] = bucket.map((m) => ({
      role: isOwnerSender(m.sender, ownerName) ? "owner" : "client",
      text: maskPhones(m.body),
      ...(m.date ? { timestamp: m.date } : {})
    }));
    const dated = bucket.filter((m) => m.date).map((m) => m.date as Date);
    episodes.push({
      chatLabel,
      episodeIndex: episodes.length,
      turns,
      ...(dated.length ? { startedAt: dated[0], endedAt: dated[dated.length - 1] } : {})
    });
    bucket = [];
  };

  for (const msg of messages) {
    if (prevDate && msg.date && msg.date.getTime() - prevDate.getTime() > gapMs) {
      commit();
    }
    bucket.push(msg);
    if (msg.date) prevDate = msg.date;
  }
  commit();
  return episodes;
}

/** Маскирует ярлык чата (имя контакта/файл): срезает телефоны и расширение. */
export function maskChatLabel(label: string): string {
  return maskPhones(label.replace(/\.(txt|json|zip)$/i, "").replace(/^_chat$/i, "чат")).trim() || "чат";
}

/** Парсит .txt-экспорт WhatsApp одного чата в эпизоды. */
export function parseWhatsappTxt(content: string, options: ParseOptions = {}): DialogueEpisode[] {
  const chatLabel = maskChatLabel(options.chatLabel ?? "чат");
  const splitDays = options.splitDays ?? DEFAULT_EPISODE_SPLIT_DAYS;
  const messages = collectRawMessages(content);
  if (messages.length === 0) return [];
  return splitEpisodes(messages, options.ownerName, chatLabel, splitDays);
}

// ── wtsexporter JSON ──

type WtsMessage = {
  from_me?: boolean;
  timestamp?: number;
  data?: string | null;
  meta?: boolean;
  media?: boolean;
  sender?: string | null;
};
type WtsChat = { name?: string | null; messages?: Record<string, WtsMessage> | WtsMessage[] };

function coerceMessages(messages: WtsChat["messages"]): WtsMessage[] {
  if (Array.isArray(messages)) return messages;
  if (messages && typeof messages === "object") return Object.values(messages);
  return [];
}

function wtsTimestamp(ts?: number): Date | undefined {
  if (!ts || !Number.isFinite(ts)) return undefined;
  // wtsexporter обычно в секундах; если похоже на мс — делим.
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Парсит один чат из wtsexporter JSON в эпизоды. */
export function parseWtsexporterChat(
  chat: WtsChat,
  chatKey: string,
  options: ParseOptions = {}
): DialogueEpisode[] {
  const chatLabel = maskChatLabel(options.chatLabel ?? chat.name ?? chatKey);
  const splitDays = options.splitDays ?? DEFAULT_EPISODE_SPLIT_DAYS;
  const raw: RawMessage[] = coerceMessages(chat.messages)
    .filter((m) => !m.meta && !m.media && typeof m.data === "string" && m.data.trim())
    .map((m) => ({
      // from_me — надёжный признак владельца; sender оставляем для fallback-матча.
      sender: m.from_me ? "__owner__" : m.sender ?? "client",
      body: (m.data as string).trim(),
      date: wtsTimestamp(m.timestamp)
    }))
    .filter((m) => !SYSTEM_NOTICE_RE.test(m.body) && !MEDIA_PLACEHOLDER_RE.test(stripMarks(m.body)));
  const sorted = sortChronologically(raw);

  if (sorted.length === 0) return [];
  // Владелец в JSON помечен sender="__owner__" (по from_me), ownerName не нужен.
  return splitEpisodes(sorted, "__owner__", chatLabel, splitDays);
}

/** Парсит весь дамп wtsexporter (объект {chatKey → chat}) во все эпизоды. */
export function parseWtsexporterJson(json: unknown, options: ParseOptions = {}): DialogueEpisode[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, WtsChat>;
  const episodes: DialogueEpisode[] = [];
  for (const [chatKey, chat] of Object.entries(root)) {
    if (!chat || typeof chat !== "object") continue;
    episodes.push(...parseWtsexporterChat(chat, chatKey, options));
  }
  return episodes;
}

// ── History sync (продуктовый источник: захват из WhatsApp) ──

/** Сырое сообщение из history-sync WhatsApp (см. apps/wa-worker). */
export type HistoryMessage = { fromMe: boolean; text: string; ts?: number };

/**
 * Строит эпизоды из истории WhatsApp (owner = fromMe). Тайминги из ts (сек или мс),
 * маскирование телефонов, разрез на эпизоды по паузе — как у файловых источников.
 */
export function parseHistoryMessages(
  messages: HistoryMessage[],
  options: ParseOptions = {}
): DialogueEpisode[] {
  const chatLabel = maskChatLabel(options.chatLabel ?? "чат");
  const splitDays = options.splitDays ?? DEFAULT_EPISODE_SPLIT_DAYS;
  const raw: RawMessage[] = messages
    .filter((m) => typeof m.text === "string" && m.text.trim().length > 0)
    .map((m) => ({
      sender: m.fromMe ? "__owner__" : "client",
      body: m.text.trim(),
      date: m.ts ? new Date(m.ts > 1e12 ? m.ts : m.ts * 1000) : undefined
    }))
    .filter((m) => !SYSTEM_NOTICE_RE.test(m.body) && !MEDIA_PLACEHOLDER_RE.test(stripMarks(m.body)));
  const sorted = sortChronologically(raw);
  if (sorted.length === 0) return [];
  return splitEpisodes(sorted, "__owner__", chatLabel, splitDays);
}

/**
 * «Оживляет» Date-поля эпизодов после round-trip через JSON/JSONB.
 * При сохранении в БД (Prisma JSON) Date сериализуется в ISO-строку; при чтении
 * обратно это строка, а formatEpisodeForPrompt зовёт .getTime() — без ревайва
 * упадёт с TypeError. Мутирует не входные объекты, а возвращает новые.
 */
export function reviveEpisodeDates(episodes: DialogueEpisode[]): DialogueEpisode[] {
  const toDate = (v: unknown): Date | undefined => {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
    if (typeof v === "string" || typeof v === "number") {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
    return undefined;
  };
  return episodes.map((ep) => {
    const startedAt = toDate(ep.startedAt);
    const endedAt = toDate(ep.endedAt);
    return {
      chatLabel: ep.chatLabel,
      episodeIndex: ep.episodeIndex,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      turns: ep.turns.map((t) => {
        const timestamp = toDate(t.timestamp);
        return { role: t.role, text: t.text, ...(timestamp ? { timestamp } : {}) };
      })
    };
  });
}

/**
 * Единая точка входа: определяет формат по имени файла/содержимому и парсит.
 * `.json` → wtsexporter; иначе → WhatsApp .txt.
 */
export function parseDialogueSource(
  content: string,
  options: ParseOptions & { filename?: string } = {}
): DialogueEpisode[] {
  const isJson = options.filename?.toLowerCase().endsWith(".json") || /^\s*\{/.test(content);
  if (isJson) {
    try {
      return parseWtsexporterJson(JSON.parse(content), options);
    } catch {
      // Не распарсился как JSON — пробуем как .txt.
    }
  }
  return parseWhatsappTxt(content, options);
}
