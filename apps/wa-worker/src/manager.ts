import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
} from "@whiskeysockets/baileys";
import { env } from "./env.js";
import { useDbAuthState } from "./db-auth-state.js";
import { getInboundQueue, type WaInboundJob } from "@jazu/queue";

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
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempts: number;
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

type WAMessageLike = {
  key: { fromMe?: boolean | null; remoteJid?: string | null; id?: string | null };
  pushName?: string | null;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    imageMessage?: { caption?: string | null } | null;
    videoMessage?: { caption?: string | null } | null;
    documentMessage?: { caption?: string | null } | null;
  } | null;
};

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
 * Положить inbound в Redis-очередь wa:inbound. Используется как основной
 * путь обработки — освобождает Baileys event loop моментально.
 */
async function enqueueInbound(
  agentId: string,
  chatId: string,
  senderName: string | undefined,
  message: string,
  waMessageId: string | undefined,
  workerSessionId: string
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
    ...(waMessageId !== undefined ? { waMessageId } : {})
  };
  await queue.add("wa-inbound", payload, {
    // Тот же dedupe-ключ, что и в API endpoint /whatsapp/inbound/enqueue.
    ...(waMessageId ? { jobId: `wa:${agentId}:${waMessageId}` } : {})
  });
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
  message: string,
  waMessageId: string | undefined,
  workerSessionId: string
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
      message,
      waMessageId
    })
  });

  if (!response.ok) {
    throw new Error(`Inbound call failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as { reply?: string; summary?: string; leadId?: string | null };
}

export class ConnectionManager {
  private connections = new Map<string, ManagedConnection>();

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

  async start(agentId: string, options: { fresh?: boolean } = {}): Promise<PublicConnectionState> {
    const existing = this.getConnection(agentId);
    if (!options.fresh && existing && !existing.stopRequested && existing.status !== "disconnected") {
      return this.publicState(existing);
    }

    const { state, saveCreds } = await useDbAuthState(agentId, { fresh: options.fresh ?? false });
    const version = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      version: version.version,
      auth: state,
      printQRInTerminal: false,
      // WhatsApp проверяет browser-tuple при выдаче pairing code и сохраняет
      // первый элемент как имя «устройства» в Linked Devices у клиента.
      // Поэтому ставим бренд `app.jazu.chat`, а второй/третий элементы
      // оставляем как у Browsers.ubuntu("Chrome") — это самая совместимая
      // комбинация для pairing-code flow, отклонений на стороне WhatsApp
      // на ней не наблюдалось.
      // Влияет ТОЛЬКО на будущие привязки: уже подключённые сессии в
      // Linked Devices остаются с прежним именем до перепривязки.
      browser: ["app.jazu.chat", "Chrome", "Ubuntu"]
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
      reconnectAttempts: existingAttempts,
      pairingMode: existing?.pairingMode ?? false,
      pairingCode: existing?.pairingCode ?? null,
      pairingCodeIssuedAt: existing?.pairingCodeIssuedAt ?? 0,
      pairingPhone: existing?.pairingPhone ?? null
    });

    socket.ev.on("creds.update", saveCreds);

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
              workerSessionId: managed.workerSessionId
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
            workerSessionId: managed.workerSessionId
          });
        }
      }

      if (update.connection === "close") {
        const reasonCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        managed.status = "disconnected";
        managed.lastSeenAt = new Date();
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
          continue;
        }

        const text = getTextMessage(message);
        if (!text) {
          continue;
        }

        const chatId = message.key.remoteJid;
        if (!chatId) {
          continue;
        }

        const senderName = message.pushName || undefined;
        const waMsgId = message.key.id ?? undefined;

        // Production path: enqueue в Redis. Ответ прилетит обратно через
        // wa:outbound и его отправит outboundWorker (другой consumer ниже).
        // Baileys event loop не блокируется ни на LLM, ни на DB.
        if (env.REDIS_URL) {
          try {
            await enqueueInbound(agentId, chatId, senderName, text, waMsgId, managed.workerSessionId);
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
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const result = await sendInboundToApi(
              agentId,
              chatId,
              senderName,
              text,
              waMsgId,
              managed.workerSessionId
            );
            if (result.reply) {
              await socket.sendMessage(chatId, { text: result.reply });
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
  async pair(agentId: string, phoneDigits: string): Promise<{ code: string; phone: string }> {
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

    await this.start(agentId, { fresh: true });
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

  async send(agentId: string, payload: { chatId: string; text: string }): Promise<void> {
    const connection = this.getConnection(agentId);
    if (!connection?.socket) {
      throw new Error("Connection is not active");
    }

    // Простой per-chatId rate-limit: не чаще одного сообщения за заданный
    // интервал (по умолчанию 1.2с). WhatsApp банит ботов за бурсты —
    // это первый ад-хок защитный слой; масштабный rate-limit на стороне
    // outbound-консьюмера в bullmq (см. handlers/wa-outbound.ts).
    const MIN_INTERVAL_MS = env.WA_PER_CHAT_MIN_INTERVAL_MS;
    const last = connection.lastSentAt.get(payload.chatId) ?? 0;
    const now = Date.now();
    const wait = MIN_INTERVAL_MS - (now - last);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    await connection.socket.sendMessage(payload.chatId, { text: payload.text });
    connection.lastSentAt.set(payload.chatId, Date.now());
    connection.lastSeenAt = new Date();
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
