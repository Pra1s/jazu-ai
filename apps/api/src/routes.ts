import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@jazu/db";
import { capturePostHog } from "@jazu/observability";
import { actionButtonSchema, businessProfileSchema, type ActionButton, type Carcass, type PromptCard } from "@jazu/shared";
import {
  applyEnrichment,
  applyPromptCorrection,
  buildBuilderTurn,
  buildFallbackPrompt,
  buildRuntimeTurn,
  createInitialProfile,
  mergeProfile,
  summarizeLead,
  transcribeAudio,
  parseDialogueSource,
  parseHistoryMessages,
  type DialogueEpisode,
  type HistoryMessage
} from "@jazu/ai";
import { env } from "./env.js";
import {
  getCurrentAgent,
  getOrCreateAgent,
  getOrCreateSession,
  getUserFromRequest,
  revokeSession,
  rotateAndLoginSession,
  SESSION_COOKIE
} from "./lib/session.js";
import {
  clearAuthCookieOptions,
  generateMagicCode,
  hashMagicCode,
  MAGIC_CODE_TTL_MS,
  verifyInternalToken,
  verifyMagicLink
} from "./lib/auth.js";
import { normalizeKzRuPhone } from "./lib/phone.js";
import { hashWaPhone } from "./lib/phone-hash.js";
import { deleteUserAccount } from "./lib/account-deletion.js";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleProfile,
  generatePkcePair,
  isGoogleConfigured
} from "./lib/google.js";
import { getWorkerConnection, pairWorkerConnection, sendWorkerMessage, startWorkerConnection, stopWorkerConnection } from "./lib/worker-client.js";
import {
  CUSTOM_MAX,
  CUSTOM_MIN,
  CUSTOM_STEP,
  FREE_TRIAL_DIALOGS,
  PLANS,
  PRICE_PER_DIALOG_KZT,
  getPlan,
  buildLlmTelemetry,
  getDailyTokenUsage,
  getUsageView,
  processWaInbound,
  clearStyle
} from "@jazu/wa-pipeline";
import { getInboundQueue, getStyleAnalyzeQueue } from "@jazu/queue";
import { sendMagicCodeEmail, sendTelegramLead, sendEnterpriseLeadEmail } from "./lib/notifications.js";
import { recordAudit } from "./lib/audit.js";
import { conversionActionForEvent, uploadAdConversion } from "./lib/google-ads.js";

const magicLinkBodySchema = z.object({
  email: z.string().email(),
  // Поле сохранено как опциональное для обратной совместимости со
  // старыми клиентами: они могут продолжать слать phone, но сервер его
  // больше не использует. Номер запрашивается отдельно на /auth/phone
  // после клика по magic-link (как в Google-флоу).
  phone: z.string().optional()
});

const phoneBodySchema = z.object({
  phone: z.string().min(1)
});

const chatBodySchema = z
  .object({
    message: z.string().min(1).optional(),
    // Голосовое: сырой base64 аудио. ~6 МБ — большой лимит, принимаем
    // практически любое голосовое. Распознаётся на сервере, для LLM идёт
    // транскрипт, а в чате сохраняется аудио-часть (плеер).
    audioBase64: z.string().min(1).max(8_000_000).optional(),
    mimeType: z.string().max(100).optional()
  })
  .refine((b) => Boolean(b.message?.trim() || b.audioBase64), {
    message: "message or audioBase64 required"
  });

const correctBodySchema = z.object({
  messageId: z.string().optional(),
  correction: z.string().min(1)
});

const settingsBodySchema = z.object({
  telegramChatId: z.string().optional(),
  displayName: z.string().optional(),
  onboardingState: z.unknown().optional()
});

const botStateBodySchema = z.object({
  botEnabled: z.boolean()
});

const whatsappInboundSchema = z.object({
  agentId: z.string().min(1),
  chatId: z.string().min(1),
  senderName: z.string().optional(),
  senderPhone: z.string().optional(),
  message: z.string().min(1),
  waMessageId: z.string().optional(),
  // Baileys.message.messageTimestamp — Unix-секунды. Используется для
  // фильтра «бот отвечает только после подключения». Опционально для
  // обратной совместимости с тестами и legacy интеграциями.
  messageTimestamp: z.number().int().positive().optional()
});

const whatsappSendBodySchema = z.object({
  chatId: z.string().min(1),
  text: z.string().min(1)
});

const leadPatchSchema = z.object({
  status: z.enum(["new", "seen", "done"]).optional()
});

/**
 * waChatId, под которым в БД хранится conversation, создаваемая из
 * тестового чата ({@link app.post}("/test-chat/chat")). Она нужна, чтобы у
 * `writeLeadIfNeeded` было куда писать summary при handoff в тесте, но
 * наружу в /chats и /leads такие conversation/leads НЕ показываются —
 * это не настоящий клиент. Если когда-нибудь захотим помечать тесты в
 * схеме (поле isTest на Conversation) — заменим эту константу на флаг.
 */
const TEST_CONVERSATION_CHAT_ID = "test-conversation";

type SseStream = {
  writeEvent: (event: string, data: unknown) => void;
  end: () => void;
};

function startSseStream(request: FastifyRequest, reply: FastifyReply): SseStream {
  const origin = request.headers.origin;
  const allowedOrigin = origin && origin === env.WEB_ORIGIN ? origin : env.WEB_ORIGIN;

  reply.hijack();

  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  raw.setHeader("Cache-Control", "no-cache, no-transform");
  raw.setHeader("Connection", "keep-alive");
  raw.setHeader("X-Accel-Buffering", "no");
  raw.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  raw.setHeader("Access-Control-Allow-Credentials", "true");
  raw.setHeader("Vary", "Origin");

  raw.flushHeaders?.();
  let ended = false;

  const writeEvent = (event: string, data: unknown) => {
    if (ended || raw.writableEnded) {
      return;
    }
    raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const end = () => {
    if (ended || raw.writableEnded) {
      return;
    }
    ended = true;
    raw.end();
  };

  request.raw.on("close", () => {
    ended = true;
  });

  return { writeEvent, end };
}

type AssistantPart = {
  type: string;
  text?: string;
  action_button?: ActionButton;
  prompt_card?: PromptCard;
  audio_base64?: string;
  audio_mime?: string;
};

function toAssistantParts(text: string, actionButton?: unknown, promptCard?: PromptCard) {
  const parts: AssistantPart[] = [{ type: "text", text }];
  if (promptCard) {
    parts.push({ type: "prompt_card", prompt_card: promptCard });
  }
  if (actionButton) {
    parts.push({ type: "action_button", action_button: actionButtonSchema.parse(actionButton) });
  }
  return parts;
}

/**
 * Разбирает тело чат-запроса в текст хода + parts для user-сообщения.
 * Если пришло голосовое (audioBase64) — распознаём на сервере (для LLM),
 * а в parts кладём аудио-часть, чтобы в ленте показывался плеер, а не текст.
 * Транскрипт идёт в content/text (нужен истории и контексту LLM).
 */
async function resolveChatInput(
  body: z.infer<typeof chatBodySchema>
): Promise<{ message: string; userParts: AssistantPart[] }> {
  if (body.audioBase64) {
    const buffer = Buffer.from(body.audioBase64, "base64");
    let transcript = "";
    try {
      transcript = (
        await transcribeAudio(buffer, {
          mimeType: body.mimeType ?? "audio/webm",
          filename: "voice.webm",
          language: "ru"
        })
      ).trim();
    } catch (err) {
      console.error("[resolveChatInput] voice transcription failed", err);
    }
    const message = transcript || "[голосовое сообщение]";
    return {
      message,
      userParts: [
        {
          type: "audio",
          audio_base64: body.audioBase64,
          audio_mime: body.mimeType ?? "audio/webm",
          text: message
        }
      ]
    };
  }
  const message = body.message?.trim() ?? "";
  return { message, userParts: [{ type: "text", text: message }] };
}

function diffPromptVersions(prev: string | null, next: string): { added: string[]; removed: string[] } {
  if (!prev) {
    return { added: [], removed: [] };
  }

  const prevSet = new Set(
    prev
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
  );
  const nextSet = new Set(
    next
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
  );

  const added: string[] = [];
  for (const rawLine of next.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (!prevSet.has(line)) {
      added.push(line);
    }
  }
  const removed: string[] = [];
  for (const rawLine of prev.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (!nextSet.has(line)) {
      removed.push(line);
    }
  }
  return { added, removed };
}

function buildPromptCard(
  prev: string | null,
  next: string,
  options: {
    changeKind?: "create" | "edit" | "correction";
    changeSummary?: string;
    correctionType?: string;
    sectionEdited?: string;
  } = {}
): PromptCard | undefined {
  if (!next) return undefined;
  const meta = {
    ...(options.changeSummary ? { changeSummary: options.changeSummary } : {}),
    ...(options.correctionType ? { correctionType: options.correctionType } : {}),
    ...(options.sectionEdited ? { sectionEdited: options.sectionEdited } : {})
  };
  if (!prev) {
    return {
      kind: "update",
      changeKind: options.changeKind ?? "create",
      prompt: next,
      addedLines: [],
      removedLines: [],
      charCount: next.length,
      editsCount: 0,
      ...meta
    };
  }
  if (prev === next) {
    return undefined;
  }
  const { added, removed } = diffPromptVersions(prev, next);
  const isCorrection = options.changeKind === "correction";
  return {
    kind: isCorrection ? "correction" : "edits",
    changeKind: options.changeKind ?? "edit",
    prompt: next,
    addedLines: added,
    removedLines: removed,
    charCount: next.length,
    editsCount: added.length + removed.length,
    ...meta
  };
}

function isProfileReadyForPrompt(profile: ReturnType<typeof businessProfileSchema.parse>): boolean {
  const hasNiche = Boolean(profile.niche && profile.niche.trim().length > 1);
  const hasServices = Array.isArray(profile.servicesList) && profile.servicesList.length > 0;
  const hasGeography = Boolean(profile.geography && profile.geography.trim().length > 1);
  const hasLeadGoal = Boolean(profile.leadGoal && profile.leadGoal.trim().length > 1);
  return hasNiche && hasServices && hasGeography && hasLeadGoal;
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkForTyping(text: string, targetChunks: number): string[] {
  if (!text) return [];
  const total = text.length;
  const desired = Math.max(20, Math.min(targetChunks, 220));
  const size = Math.max(1, Math.ceil(total / desired));
  const chunks: string[] = [];
  for (let i = 0; i < total; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

async function typeTokens(
  stream: SseStream,
  text: string,
  options: { perChunkMs?: number; targetChunks?: number } = {}
) {
  if (!text) return;
  const perChunkMs = options.perChunkMs ?? 22;
  const chunks = chunkForTyping(text, options.targetChunks ?? 140);
  for (const chunk of chunks) {
    stream.writeEvent("token", { token: chunk });
    if (perChunkMs > 0) {
      await sleep(perChunkMs);
    }
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function ensureAgentProfile(agentId: string) {
  const existing = await prisma.businessProfile.findUnique({
    where: { agentId }
  });

  if (existing) {
    return businessProfileSchema.parse(existing.data);
  }

  const profile = createInitialProfile();
  await prisma.businessProfile.create({
    data: {
      agentId,
      data: profile
    }
  });
  return profile;
}

async function savePromptVersion(
  agentId: string,
  content: string,
  source: "create" | "edit" | "correction" | "enrichment",
  meta?: { correctionType?: string | null; sectionEdited?: string | null }
) {
  const previous = await prisma.promptVersion.findFirst({
    where: { agentId },
    orderBy: { createdAt: "desc" }
  });

  await prisma.promptVersion.create({
    data: {
      agentId,
      content,
      charCount: content.length,
      source,
      createdBy: "ai",
      correctionType: meta?.correctionType ?? null,
      sectionEdited: meta?.sectionEdited ?? null,
      parentId: previous?.id ?? null,
      metadata: {
        updatedAt: new Date().toISOString()
      }
    }
  });

  await prisma.agent.update({
    where: { id: agentId },
    data: {
      currentPrompt: content,
      readyToFinalize: true
    }
  });
}

type HandoffType = "hot_lead" | "complaint" | "out_of_scope" | "requested" | null;

function handoffNotificationTitle(handoffType: HandoffType): string {
  switch (handoffType) {
    case "hot_lead":
      return "<b>🔥 Горячий лид</b>";
    case "complaint":
      return "<b>⚠️ Жалоба - срочно</b>";
    case "out_of_scope":
      return "<b>❓ Нестандартный вопрос</b>";
    case "requested":
      return "<b>📞 Просят менеджера</b>";
    default:
      return "<b>Новый лид</b>";
  }
}

async function writeLeadIfNeeded(
  agentId: string,
  conversationId: string,
  summary: string,
  message: string,
  shouldCreate: boolean,
  handoffType: HandoffType = null
) {
  if (!shouldCreate) {
    return null;
  }

  // Avoid duplicates: return existing open lead for this conversation
  const existing = await prisma.lead.findFirst({
    where: { conversationId, status: "new" }
  });
  if (existing) {
    return existing;
  }

  const lead = await prisma.lead.create({
    data: {
      conversationId,
      summary,
      niche: null,
      fields: {
        sourceMessage: message,
        createdAt: new Date().toISOString(),
        ...(handoffType ? { handoffType } : {})
      },
      status: "new"
    }
  });

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { user: true }
  });

  if (agent?.user?.telegramChatId) {
    sendTelegramLead(
      agent.user.telegramChatId,
      [handoffNotificationTitle(handoffType), summary, `Agent: ${agent.name}`].join("\n")
    ).catch((err: unknown) => {
      console.error("Telegram notification failed (non-fatal):", err instanceof Error ? err.message : err);
    });
  }

  return lead;
}

async function getOrCreateConversation(agentId: string, chatId: string, customerName?: string) {
  const updateData: {
    customerName?: string | null;
    lastMessageAt: Date;
    status: "open";
  } = {
    lastMessageAt: new Date(),
    status: "open"
  };

  if (customerName !== undefined) {
    updateData.customerName = customerName;
  }

  return prisma.conversation.upsert({
    where: {
      agentId_waChatId: {
        agentId,
        waChatId: chatId
      }
    },
    update: updateData,
    create: {
      agentId,
      waChatId: chatId,
      customerName: customerName ?? null,
      status: "open",
      lastMessageAt: new Date()
    }
  });
}

async function ensureWaConnection(agentId: string) {
  return prisma.waConnection.upsert({
    where: { agentId },
    update: {},
    create: {
      agentId,
      status: "disconnected",
      authState: {},
      qrText: null
    }
  });
}

async function buildSessionView(request: FastifyRequest, reply: FastifyReply) {
  const session = await getOrCreateSession(request, reply);
  const user = await getUserFromRequest(request);
  const agent = await getCurrentAgent(request, reply);
  return { session, user, agent };
}

/** For write paths that need an agent — creates one if missing */
async function buildWriteSessionView(request: FastifyRequest, reply: FastifyReply) {
  const session = await getOrCreateSession(request, reply);
  const user = await getUserFromRequest(request);
  const agent = await getOrCreateAgent(request, reply);
  return { session, user, agent };
}

export const apiRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({
    ok: true,
    name: "jazu-api",
    timestamp: new Date().toISOString()
  }));

  app.get("/session", async (request, reply) => {
    const session = await getOrCreateSession(request, reply);
    return {
      sessionId: session.cookieId,
      readyToFinalize: session.readyToFinalize,
      isGenerating: session.isGenerating,
      promptDraft: session.promptDraft
    };
  });

  app.post("/session", async (request, reply) => {
    const session = await getOrCreateSession(request, reply);
    return {
      sessionId: session.cookieId,
      readyToFinalize: session.readyToFinalize,
      isGenerating: session.isGenerating
    };
  });

  // Конверсия из воронки -> Google Ads (S2S через Data Manager API). Публичный,
  // без auth: это тот же сигнал, что уходит в PostHog (см. apps/web/lib/analytics.ts),
  // поэтому Google совпадает с аналитикой. Отвечаем сразу, ingest — в фоне.
  app.post("/track/ad-conversion", async (request, reply) => {
    const body = (request.body ?? {}) as {
      event?: string;
      gclid?: string;
      gbraid?: string;
      wbraid?: string;
    };
    void (async () => {
      try {
        if (!body.event) return;
        const conversionActionId = conversionActionForEvent(body.event);
        if (!conversionActionId) return;
        const clickIds = {
          gclid: typeof body.gclid === "string" ? body.gclid : undefined,
          gbraid: typeof body.gbraid === "string" ? body.gbraid : undefined,
          wbraid: typeof body.wbraid === "string" ? body.wbraid : undefined
        };
        if (!clickIds.gclid && !clickIds.gbraid && !clickIds.wbraid) return;
        const result = await uploadAdConversion({ conversionActionId, clickIds });
        if (result.ok) {
          app.log.info({ event: body.event }, "google-ads conversion uploaded");
        } else {
          app.log.warn({ event: body.event, status: result.status, err: result.error }, "google-ads conversion failed");
        }
      } catch (err) {
        app.log.error({ err }, "google-ads conversion handler error");
      }
    })();
    return reply.code(204).send();
  });

  app.post("/auth/magic-link", {
    config: {
      // Один запрос раз в 30 секунд на email. Это:
      //  - защищает от случайных двойных кликов и от рассылочного флуда;
      //  - даёт юзеру понятный UX-таймер «можно ещё через N сек»;
      //  - закрывает enumeration по тайминговым каналам.
      // Если разные юзеры стучат с одного NAT/офиса — лимит независимый
      // на каждый email, так что друг другу они не мешают.
      // IP-плечо тоже есть через глобальный per-user/IP лимит в server.ts.
      rateLimit: {
        max: 1,
        timeWindow: "30 seconds",
        keyGenerator: (req) => {
          const body = (req.body ?? {}) as { email?: unknown };
          const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
          return email ? `magic:${email}` : `magic-ip:${req.ip}`;
        }
      }
    }
  }, async (request, reply) => {
    const body = magicLinkBodySchema.parse(request.body);
    const email = body.email.toLowerCase();

    // Телефон больше НЕ собирается на этапе magic-link: identity = email,
    // номер запрашивается отдельно после ввода кода (см. /auth/phone).
    // Поле body.phone сохранено как опциональное только для обратной
    // совместимости со старыми клиентами и здесь игнорируется.

    const session = await getOrCreateSession(request, reply);

    // Перешли с magic-link на 6-значный код: ссылка плохо работала в
    // Gmail/Outlook WebView, где почтовый клиент открывал /auth/callback
    // в собственном встроенном браузере и сессия логинилась НЕ там, где
    // юзер начал. Код вводится в исходной вкладке и проблему снимает.
    //
    // В БД храним HMAC-хеш кода (поле token), а не сам код — даже
    // утечка БД не даст залогиниться в чужой ящик до прочтения письма.
    const code = generateMagicCode();
    const codeHash = hashMagicCode(code, email, env.MAGIC_LINK_SECRET);
    const nonce = randomUUID();
    await prisma.magicLinkToken.create({
      data: {
        token: codeHash,
        email,
        nonce,
        expiresAt: new Date(Date.now() + MAGIC_CODE_TTL_MS)
      }
    });

    await sendMagicCodeEmail(email, code);
    await recordAudit({
      event: "magic_link.issued",
      request,
      metadata: { email, kind: "code" }
    });

    const response = {
      ok: true,
      email,
      // В dev отдаём код прямо в JSON, чтобы можно было быстро тестировать
      // без открытия Resend. В prod это поле никогда не появляется.
      ...(env.NODE_ENV === "development" ? { devCode: code } : {})
    };

    await prisma.session.update({
      where: { id: session.id },
      data: {
        isGenerating: false
      }
    });

    return response;
  });

  app.post("/auth/magic-link/verify", {
    config: {
      // Антиперебор: 10 попыток за минуту на email. Этого достаточно, чтобы
      // юзер мог ошибиться 2-3 раза, и слишком мало, чтобы пробежать
      // 1 000 000 комбинаций 6-значного кода.
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (req) => {
          const body = (req.body ?? {}) as { email?: unknown };
          const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
          return email ? `magic-verify:${email}` : `magic-verify-ip:${req.ip}`;
        }
      }
    }
  }, async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        code: z.string().min(4).max(12)
      })
      .parse(request.body);

    const email = body.email.trim().toLowerCase();
    const code = body.code.replace(/\s+/g, "");
    const codeHash = hashMagicCode(code, email, env.MAGIC_LINK_SECRET);

    // Атомарно «потребляем» код: usedAt: null → usedAt = now, expiresAt > now.
    // Так мы получаем one-time-use без гонок, даже если юзер дважды нажмёт
    // «Войти» — второй запрос не пройдёт.
    const consumed = await prisma.magicLinkToken.updateMany({
      where: {
        token: codeHash,
        email,
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      data: { usedAt: new Date() }
    });
    if (consumed.count !== 1) {
      await recordAudit({
        event: "magic_link.expired",
        request,
        metadata: { email, reason: "invalid_or_expired_code" }
      });
      reply.code(400);
      return { ok: false, error: "Неверный или истёкший код" };
    }

    // Создаём/находим юзера. Логика идентична magic-link callback.
    const existing = await prisma.user.findUnique({ where: { email } });
    const user = existing
      ? existing
      : await prisma.user.create({
          data: {
            email,
            name: email.split("@").at(0) ?? email
          }
        });
    // Аналитика: регистрация (новый юзер) — отделяем от повторных login.success.
    if (!existing) {
      capturePostHog({ distinctId: user.id, event: "signup_completed", properties: { method: "email_code" } });
    }

    const existingSession = await getOrCreateSession(request, reply);

    // Тот же agent-resolver, что и в /auth/callback и Google-флоу.
    const userAgent = await prisma.agent.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" }
    });

    let agent;
    if (userAgent) {
      agent = userAgent;
    } else if (existingSession.agentId) {
      const sessionAgent = await prisma.agent.findUnique({
        where: { id: existingSession.agentId }
      });
      if (sessionAgent && sessionAgent.userId === null) {
        agent = await prisma.agent.update({
          where: { id: sessionAgent.id },
          data: { userId: user.id }
        });
      } else {
        agent = null;
      }
    } else {
      agent = null;
    }
    if (!agent) {
      agent = await prisma.agent.create({
        data: {
          userId: user.id,
          name: `${user.name || "AI"} manager`,
          status: "draft",
          currentPrompt: buildFallbackPrompt(createInitialProfile()),
          readyToFinalize: false,
          businessProfile: {
            create: {
              data: createInitialProfile()
            }
          }
        }
      });
    }

    await rotateAndLoginSession(reply, existingSession.id, user.id, agent.id);

    await recordAudit({
      event: "magic_link.consumed",
      userId: user.id,
      request,
      metadata: { method: "code", newUser: !existing }
    });
    await recordAudit({
      event: "login.success",
      userId: user.id,
      request,
      metadata: { method: "magic_link" }
    });

    return {
      ok: true,
      // Клиент сам решит, куда переходить — /dashboard или /auth/phone.
      needsPhone: !user.phone
    };
  });

  app.get("/auth/callback", async (request, reply) => {
    const token = z.string().min(1).parse((request.query as Record<string, unknown>).token);

    // 1. Быстрая проверка HMAC + TTL.
    const payload = verifyMagicLink(token, env.MAGIC_LINK_SECRET, env.MAGIC_LINK_SECRET_OLD);
    if (!payload) {
      await recordAudit({ event: "login.failed", request, metadata: { reason: "invalid_signature" } });
      reply.code(400);
      return { ok: false, error: "Invalid or expired magic link" };
    }

    // 2. One-time-use через атомарный updateMany usedAt: null → usedAt = now.
    // Если count === 0 — токен уже использован, истёк, или его не существует.
    const consumed = await prisma.magicLinkToken.updateMany({
      where: {
        token,
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      data: { usedAt: new Date() }
    });
    if (consumed.count !== 1) {
      await recordAudit({
        event: "magic_link.expired",
        request,
        metadata: { email: payload.email, reason: "already_used_or_expired" }
      });
      reply.code(400);
      return { ok: false, error: "Magic link already used or expired" };
    }

    // Берём phoneSnapshot, чтобы прокинуть его в User.
    const tokenRow = await prisma.magicLinkToken.findUnique({ where: { token } });
    const phoneFromToken = tokenRow?.phoneSnapshot ?? null;

    // 3. Загружаем (или создаём) пользователя.
    const existing = await prisma.user.findUnique({ where: { email: payload.email } });
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          // Phone обновляем только если в БД его ещё нет — иначе уважаем
          // ранее выставленный номер (юзер может сменить его через /auth/phone).
          data: existing.phone ? {} : phoneFromToken ? { phone: phoneFromToken } : {}
        })
      : await prisma.user.create({
          data: {
            email: payload.email,
            name: payload.email.split("@").at(0) ?? payload.email,
            phone: phoneFromToken
          }
        });
    // Аналитика: регистрация (новый юзер) через magic-link.
    if (!existing) {
      capturePostHog({ distinctId: user.id, event: "signup_completed", properties: { method: "magic_link" } });
    }

    // 4. Берём текущую сессию (которая, скорее всего, ещё анонимная).
    const existingSession = await getOrCreateSession(request, reply);

    // 5. Решаем, какой агент принадлежит юзеру:
    //    a) если у юзера уже есть агент — берём самый старый;
    //    b) если у текущей анонимной сессии есть собственный агент без owner — переносим;
    //    c) иначе создаём новый агент.
    const userAgent = await prisma.agent.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" }
    });

    let agent;
    if (userAgent) {
      agent = userAgent;
    } else if (existingSession.agentId) {
      const sessionAgent = await prisma.agent.findUnique({
        where: { id: existingSession.agentId }
      });
      if (sessionAgent && sessionAgent.userId === null) {
        agent = await prisma.agent.update({
          where: { id: sessionAgent.id },
          data: { userId: user.id }
        });
      } else {
        agent = null;
      }
    } else {
      agent = null;
    }

    if (!agent) {
      agent = await prisma.agent.create({
        data: {
          userId: user.id,
          name: `${user.name || "AI"} manager`,
          status: "draft",
          currentPrompt: buildFallbackPrompt(createInitialProfile()),
          readyToFinalize: false,
          businessProfile: {
            create: {
              data: createInitialProfile()
            }
          }
        }
      });
    }

    // 6. Ротируем cookieId + биндим Session.userId + Session.agentId одним апдейтом.
    await rotateAndLoginSession(reply, existingSession.id, user.id, agent.id);

    await recordAudit({
      event: "magic_link.consumed",
      userId: user.id,
      request,
      metadata: { method: "magic_link", newUser: !existing }
    });
    await recordAudit({
      event: "login.success",
      userId: user.id,
      request,
      metadata: { method: "magic_link" }
    });

    // Если по какой-то причине phone у юзера ещё нет (старая запись, или
    // юзер логинится повторно через email на аккаунт без номера) —
    // ведём через подключение WhatsApp, где после привязки бота юзер
    // подтверждает личный номер для уведомлений.
    const target = user.phone ? "/dashboard" : "/whatsapp";
    reply.redirect(`${env.WEB_ORIGIN}${target}`);
    return;
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return {
        success: false,
        message: "Authentication required. Please login first."
      };
    }

    const agent = await prisma.agent.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: {
        businessProfile: true,
        promptVersions: {
          orderBy: { createdAt: "desc" },
          take: 1
        },
        waConnections: {
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });

    const usage = await getUsageView(prisma, user.id);

    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
        googleId: user.googleId,
        createdAt: user.createdAt
      },
      needsPhone: !user.phone,
      googleEnabled: isGoogleConfigured(),
      usage,
      agent
    };
  });

  // Публичный эндпоинт для логин-страницы — показывать ли кнопку Google.
  app.get("/auth/config", async () => ({
    googleEnabled: isGoogleConfigured()
  }));

  // ─── Enterprise lead ────────────────────────────────────────────────────
  const enterpriseLeadSchema = z.object({
    name: z.string().min(1).max(200),
    contact: z.string().min(1).max(200),
    comment: z.string().max(2000).optional().default("")
  });

  app.post("/enterprise/lead", async (request, reply) => {
    const body = enterpriseLeadSchema.parse(request.body);
    try {
      await sendEnterpriseLeadEmail(body);
      return { ok: true };
    } catch (err) {
      request.log.error({ err }, "enterprise lead email failed");
      reply.code(500);
      return { ok: false, error: "Не удалось отправить заявку" };
    }
  });

  // ─── Billing ────────────────────────────────────────────────────────────
  // Публичный список тарифов + цены — фронт читает один раз на /billing.
  app.get("/billing/plans", async () => ({
    pricePerDialog: PRICE_PER_DIALOG_KZT,
    currency: "KZT",
    freeTrialDialogs: FREE_TRIAL_DIALOGS,
    plans: PLANS,
    custom: { min: CUSTOM_MIN, max: CUSTOM_MAX, step: CUSTOM_STEP }
  }));

  // Текущее использование для авторизованного юзера. Используется виджетом
  // в сайдбаре с polling каждые 15с.
  app.get("/billing/me", async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { ok: false, error: "Not authenticated" };
    }
    const usage = await getUsageView(prisma, user.id);
    return { ok: true, usage };
  });

  // Дневной токен-бюджет (telemetry, для будущего UI «остался ресурс»).
  // Используется также автоматически перед каждым LLM-вызовом через
  // buildLlmTelemetry({checkBudget}) — там агрегация идёт по LlmCallLog.
  app.get("/billing/me/tokens", async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { ok: false, error: "Not authenticated" };
    }
    const status = await getDailyTokenUsage(prisma, user.id);
    return { ok: true, ...status };
  });

  // Подписка на тариф (subscribe) и докупка диалогов в рамках тарифа (topup).
  // Оплата сейчас — заглушка (Purchase сразу paid). Реальный Kaspi Pay позже.
  const subscribeBodySchema = z.object({
    action: z.literal("subscribe"),
    planId: z.enum(["business", "scale"])
  });
  const topupBodySchema = z.object({
    action: z.literal("topup"),
    count: z.number().int().min(CUSTOM_MIN).max(CUSTOM_MAX)
  });
  const purchaseBodySchema = z.union([subscribeBodySchema, topupBodySchema]);

  app.post("/billing/purchase", async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { ok: false, error: "Not authenticated" };
    }
    const body = purchaseBodySchema.parse(request.body);

    if (body.action === "subscribe") {
      const plan = getPlan(body.planId);
      if (!plan || plan.kind !== "subscription" || plan.conversations === null || plan.monthlyPriceKzt === null) {
        reply.code(400);
        return { ok: false, error: "Unknown plan" };
      }
      const conversations = plan.conversations;
      const amount = plan.monthlyPriceKzt;
      const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const purchase = await prisma.$transaction(async (tx) => {
        const created = await tx.purchase.create({
          data: {
            userId: user.id,
            packageId: plan.id,
            conversations,
            pricePerOne: plan.pricePerDialogKzt,
            amount,
            currency: "KZT",
            status: "paid"
          }
        });
        // Подписка задаёт месячный лимит поверх текущего использования
        // (quotaUsed не сбрасывается — это счётчик уникальных клиентов).
        const fresh = await tx.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { quotaUsed: true }
        });
        await tx.user.update({
          where: { id: user.id },
          data: {
            planId: plan.id,
            subscriptionEndsAt: endsAt,
            quotaTotal: fresh.quotaUsed + conversations
          }
        });
        return created;
      });

      await recordAudit({
        event: "purchase.completed",
        userId: user.id,
        request,
        metadata: { purchaseId: purchase.id, planId: plan.id, conversations, amount, currency: "KZT", kind: "subscribe" }
      });

      const usage = await getUsageView(prisma, user.id);
      return { ok: true, purchase, usage };
    }

    // topup — докупка диалогов по цене текущего тарифа.
    const fresh = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { planId: true, subscriptionEndsAt: true }
    });
    if (!fresh.planId) {
      reply.code(409);
      return { ok: false, error: "Сначала оформите тариф, потом можно докупать диалоги." };
    }
    const plan = getPlan(fresh.planId);
    const perDialogKzt = plan?.pricePerDialogKzt ?? PRICE_PER_DIALOG_KZT;
    const count = Math.max(CUSTOM_MIN, Math.min(CUSTOM_MAX, Math.round(body.count / CUSTOM_STEP) * CUSTOM_STEP));
    const amount = count * perDialogKzt;

    const purchase = await prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          userId: user.id,
          packageId: `topup_${fresh.planId}`,
          conversations: count,
          pricePerOne: perDialogKzt,
          amount,
          currency: "KZT",
          status: "paid"
        }
      });
      await tx.user.update({
        where: { id: user.id },
        data: { quotaTotal: { increment: count } }
      });
      return created;
    });

    await recordAudit({
      event: "purchase.completed",
      userId: user.id,
      request,
      metadata: { purchaseId: purchase.id, count, amount, currency: "KZT", kind: "topup" }
    });

    const usage = await getUsageView(prisma, user.id);
    return { ok: true, purchase, usage };
  });

  app.post("/auth/logout", async (request, reply) => {
    const session = await getOrCreateSession(request, reply);
    const userId = session.userId ?? null;
    await revokeSession(reply, session.id);
    await recordAudit({ event: "logout", userId, request });
    return { ok: true };
  });

  // GDPR / 152-ФЗ «право на забвение».
  // Безвозвратно удаляет аккаунт пользователя со всеми связанными данными.
  // Confirmation: юзер должен передать свой текущий email — защита от
  // случайных кликов и от XSS (атакующий с XSS-уязвимостью не знает email,
  // т.к. он рендерится в DOM только после загрузки /auth/me).
  //
  // Что происходит подробно — см. deleteUserAccount() в lib/account-deletion.ts.
  app.delete("/auth/me", {
    config: {
      // Удаление — необратимое действие. 3 попытки в минуту достаточно
      // (учесть опечатки в email), больше — подозрительно.
      rateLimit: { max: 3, timeWindow: "1 minute" }
    }
  }, async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { success: false, message: "Authentication required" };
    }

    const body = z.object({
      confirmEmail: z.string().min(1)
    }).parse(request.body ?? {});

    // Сравнение case-insensitive — email в БД сохраняем как есть, но
    // юзер мог ввести с другим регистром, что для email эквивалентно.
    if (body.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      reply.code(400);
      return {
        success: false,
        message: "Email не совпадает. Введите email, под которым вы вошли."
      };
    }

    // Записываем audit ДО удаления — иначе после wipe мы потеряем userId.
    // AuditLog.userId nullable, но «жив» как трейс события.
    await recordAudit({
      event: "account.deleted",
      userId: user.id,
      request,
      metadata: { emailHashPrefix: user.email.slice(0, 3) }
    });

    await deleteUserAccount(user.id);

    // Сессии уже снесены внутри deleteUserAccount (deleteMany). Cookie на
    // стороне браузера остаётся — явно говорим браузеру удалить его,
    // чтобы он не слал нам мёртвый cookieId при следующем запросе.
    reply.clearCookie(SESSION_COOKIE, clearAuthCookieOptions());

    return { success: true };
  });

  // ─── Google OAuth ────────────────────────────────────────────────────────
  // /auth/google/start  → редирект на consent screen.
  // /auth/google/callback → обмен code на токен, апсёрт User, биндинг сессии.

  const GOOGLE_STATE_COOKIE = "jazu_google_state";
  const GOOGLE_VERIFIER_COOKIE = "jazu_google_verifier";

  const googleTempCookieOpts = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    signed: false,
    maxAge: 60 * 10 // 10 минут — больше чем нужно для OAuth-раундтрипа
  };

  app.get("/auth/google/start", {
    config: {
      // OAuth redirect — могут досить, но юзер не залогинен, поэтому ключ
      // по IP. Лимит свободнее, чем magic-link, потому что Google делает
      // несколько внутренних редиректов на /start при retry.
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (req) => `google-start:${req.ip}`
      }
    }
  }, async (request, reply) => {
    if (!isGoogleConfigured()) {
      reply.code(503);
      return { ok: false, error: "Google OAuth is not configured on the server" };
    }
    // Создаём сессию заранее, чтобы потом было что апгрейдить в callback.
    await getOrCreateSession(request, reply);

    const { verifier, challenge } = generatePkcePair();
    const state = randomUUID();

    reply.setCookie(GOOGLE_STATE_COOKIE, state, googleTempCookieOpts);
    reply.setCookie(GOOGLE_VERIFIER_COOKIE, verifier, googleTempCookieOpts);

    const url = buildGoogleAuthUrl({ state, codeChallenge: challenge });
    reply.redirect(url);
    return;
  });

  app.get("/auth/google/callback", async (request, reply) => {
    if (!isGoogleConfigured()) {
      reply.code(503);
      return { ok: false, error: "Google OAuth is not configured on the server" };
    }
    const q = z
      .object({
        code: z.string().min(1).optional(),
        state: z.string().min(1).optional(),
        error: z.string().optional()
      })
      .parse(request.query);

    if (q.error) {
      reply.redirect(`${env.WEB_ORIGIN}/login?error=google_${encodeURIComponent(q.error)}`);
      return;
    }
    if (!q.code || !q.state) {
      reply.redirect(`${env.WEB_ORIGIN}/login?error=google_missing_code`);
      return;
    }

    const expectedState = request.cookies[GOOGLE_STATE_COOKIE];
    const verifier = request.cookies[GOOGLE_VERIFIER_COOKIE];
    reply.clearCookie(GOOGLE_STATE_COOKIE, googleTempCookieOpts);
    reply.clearCookie(GOOGLE_VERIFIER_COOKIE, googleTempCookieOpts);

    if (!expectedState || !verifier || expectedState !== q.state) {
      reply.redirect(`${env.WEB_ORIGIN}/login?error=google_state_mismatch`);
      return;
    }

    let profile;
    try {
      const tokens = await exchangeGoogleCode({ code: q.code, codeVerifier: verifier });
      profile = await fetchGoogleProfile(tokens.accessToken);
    } catch (err) {
      app.log.error({ err }, "Google OAuth callback failed");
      reply.redirect(`${env.WEB_ORIGIN}/login?error=google_exchange_failed`);
      return;
    }

    // Привязка google-аккаунта к существующему юзеру или создание нового.
    // Приоритеты:
    //  1) если уже есть User с этим googleId — берём его;
    //  2) иначе ищем по email и докидываем googleId/avatarUrl;
    //  3) иначе создаём нового без phone (phone попросим на следующем экране).
    const byGoogle = await prisma.user.findUnique({ where: { googleId: profile.sub } });
    let user = byGoogle;
    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email: profile.email.toLowerCase() } });
      if (byEmail) {
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: {
            googleId: profile.sub,
            avatarUrl: profile.picture ?? byEmail.avatarUrl,
            name: byEmail.name ?? profile.name ?? null
          }
        });
      } else {
        user = await prisma.user.create({
          data: {
            email: profile.email.toLowerCase(),
            name: profile.name ?? null,
            googleId: profile.sub,
            avatarUrl: profile.picture ?? null
          }
        });
        // Аналитика: регистрация (новый юзер) через Google.
        capturePostHog({ distinctId: user.id, event: "signup_completed", properties: { method: "google" } });
      }
    }

    // Подбираем или создаём агента (та же логика, что в /auth/callback).
    const existingSession = await getOrCreateSession(request, reply);
    const userAgent = await prisma.agent.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" }
    });

    let agent;
    if (userAgent) {
      agent = userAgent;
    } else if (existingSession.agentId) {
      const sessionAgent = await prisma.agent.findUnique({ where: { id: existingSession.agentId } });
      if (sessionAgent && sessionAgent.userId === null) {
        agent = await prisma.agent.update({
          where: { id: sessionAgent.id },
          data: { userId: user.id }
        });
      } else {
        agent = null;
      }
    } else {
      agent = null;
    }
    if (!agent) {
      agent = await prisma.agent.create({
        data: {
          userId: user.id,
          name: `${user.name || "AI"} manager`,
          status: "draft",
          currentPrompt: buildFallbackPrompt(createInitialProfile()),
          readyToFinalize: false,
          businessProfile: { create: { data: createInitialProfile() } }
        }
      });
    }

    await rotateAndLoginSession(reply, existingSession.id, user.id, agent.id);

    if (!byGoogle) {
      await recordAudit({
        event: "google.linked",
        userId: user.id,
        request,
        metadata: { email: profile.email.toLowerCase() }
      });
    }
    await recordAudit({
      event: "login.success",
      userId: user.id,
      request,
      metadata: { method: "google" }
    });

    // Phone обязателен. Если у юзера его ещё нет — ведём через подключение
    // WhatsApp: сначала /whatsapp (привязка бота), затем уже на этом экране
    // подтверждение личного номера для уведомлений.
    const target = user.phone ? "/dashboard" : "/whatsapp";
    reply.redirect(`${env.WEB_ORIGIN}${target}`);
    return;
  });

  // ─── Phone capture (после Google-логина или для смены номера) ────────────
  app.post("/auth/phone", {
    config: {
      // Защита от bruteforce: один юзер не может потратить больше 10 попыток
      // в минуту на ввод/смену номера (чтобы не делать enumeration по чужим
      // занятым номерам через 409). Ключ — userId (глобальный hook резолвит).
      rateLimit: { max: 10, timeWindow: "1 minute" }
    }
  }, async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { ok: false, error: "Authentication required" };
    }
    const { phone } = phoneBodySchema.parse(request.body);
    const normalized = normalizeKzRuPhone(phone);
    if (!normalized) {
      reply.code(400);
      return { ok: false, error: "Введите номер в формате +7XXXXXXXXXX" };
    }

    const owner = await prisma.user.findUnique({ where: { phone: normalized } });
    if (owner && owner.id !== user.id) {
      reply.code(409);
      return { ok: false, error: "Этот номер уже привязан к другому аккаунту" };
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { phone: normalized }
    });

    await recordAudit({
      event: "phone.updated",
      userId: user.id,
      request,
      metadata: { changed: user.phone !== normalized }
    });

    return { ok: true, phone: normalized };
  });

  // ─── Верификация личного номера через код с номера WhatsApp-бота ─────────
  // Шаг 1: пользователь вводит личный номер. Сравниваем с номером бота.
  // Если совпадает — считаем верифицированным сразу (код не нужен).
  // Если отличается — генерим код и шлём его с номера бота на личный номер.
  app.post("/auth/phone/verify-start", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { ok: false, error: "Authentication required" };
    }
    const { phone } = phoneBodySchema.parse(request.body);
    const normalized = normalizeKzRuPhone(phone);
    if (!normalized) {
      reply.code(400);
      return { ok: false, error: "Введите номер в формате +7XXXXXXXXXX" };
    }

    const owner = await prisma.user.findUnique({ where: { phone: normalized } });
    if (owner && owner.id !== user.id) {
      reply.code(409);
      return { ok: false, error: "Этот номер уже привязан к другому аккаунту" };
    }

    // Ищем подключённого бота этого пользователя, чтобы (а) сравнить номер,
    // (б) иметь канал для отправки кода.
    const connectedAgent = await prisma.agent.findFirst({
      where: { userId: user.id, waConnections: { some: { status: "connected" } } },
      select: {
        id: true,
        waConnections: { where: { status: "connected" }, select: { phone: true }, take: 1 }
      }
    });
    const botPhone = connectedAgent?.waConnections?.[0]?.phone ?? null;
    const botNormalized = botPhone ? normalizeKzRuPhone(botPhone) : null;

    // Личный номер совпадает с номером бота — верификация не нужна.
    if (botNormalized && botNormalized === normalized) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          phone: normalized,
          phoneVerifiedAt: new Date(),
          phonePending: null,
          phoneVerifyCode: null,
          phoneVerifyExpiresAt: null,
          phoneVerifyAttempts: 0
        }
      });
      return { ok: true, verified: true };
    }

    // Номер отличается — нужен код. Без подключённого бота отправить нельзя.
    if (!connectedAgent) {
      reply.code(409);
      return { ok: false, error: "Сначала подключите WhatsApp, код придёт с номера бота." };
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        phonePending: normalized,
        phoneVerifyCode: code,
        phoneVerifyExpiresAt: expiresAt,
        phoneVerifyAttempts: 0
      }
    });

    const targetDigits = normalized.replace(/\D+/g, "");
    try {
      await sendWorkerMessage(connectedAgent.id, {
        chatId: `${targetDigits}@s.whatsapp.net`,
        text: `Jazu: ваш код подтверждения - ${code}. Введите его в кабинете, чтобы получать уведомления о лидах. Код действует 10 минут.`
      });
    } catch (err) {
      request.log.error({ err, userId: user.id }, "phone verify code send failed");
      reply.code(502);
      return { ok: false, error: "Не удалось отправить код. Попробуйте ещё раз." };
    }

    return { ok: true, verified: false, codeSent: true };
  });

  // Шаг 2: пользователь вводит код. Проверяем и переносим phonePending в phone.
  app.post("/auth/phone/verify-confirm", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { ok: false, error: "Authentication required" };
    }
    const { code } = z.object({ code: z.string().min(4).max(8) }).parse(request.body);

    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        phonePending: true,
        phoneVerifyCode: true,
        phoneVerifyExpiresAt: true,
        phoneVerifyAttempts: true
      }
    });
    if (!fresh?.phoneVerifyCode || !fresh.phonePending || !fresh.phoneVerifyExpiresAt) {
      reply.code(400);
      return { ok: false, error: "Код не запрошен. Начните заново." };
    }
    if (fresh.phoneVerifyExpiresAt.getTime() < Date.now()) {
      reply.code(400);
      return { ok: false, error: "Код истёк. Запросите новый." };
    }
    if (fresh.phoneVerifyAttempts >= 5) {
      reply.code(429);
      return { ok: false, error: "Слишком много попыток. Запросите новый код." };
    }
    if (fresh.phoneVerifyCode !== code.trim()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { phoneVerifyAttempts: { increment: 1 } }
      });
      reply.code(400);
      return { ok: false, error: "Неверный код" };
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        phone: fresh.phonePending,
        phoneVerifiedAt: new Date(),
        phonePending: null,
        phoneVerifyCode: null,
        phoneVerifyExpiresAt: null,
        phoneVerifyAttempts: 0
      }
    });

    await recordAudit({ event: "phone.verified", userId: user.id, request, metadata: {} });
    return { ok: true, verified: true };
  });

  app.get("/agent/history", async (request, reply) => {
    const agent = await getCurrentAgent(request, reply);
    if (!agent) {
      return [];
    }
    const messages = await prisma.builderMessage.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: "asc" }
    });

    return messages;
  });

  app.get("/agent/prompt", async (request, reply) => {
    const agent = await getCurrentAgent(request, reply);
    const profile = agent
      ? await ensureAgentProfile(agent.id)
      : createInitialProfile();
    if (!agent) {
      return { prompt: buildFallbackPrompt(profile), businessProfile: profile };
    }
    const promptVersion = await prisma.promptVersion.findFirst({
      where: { agentId: agent.id },
      orderBy: { createdAt: "desc" }
    });

    return {
      prompt: promptVersion?.content || agent.currentPrompt || buildFallbackPrompt(profile),
      businessProfile: profile
    };
  });

  // Доп-данные бизнеса: структурированный ввод (ссылки, прайс, скрипт,
  // филиалы+часы, ограничения). Мерджим в businessProfile поверх собранного чатом.
  const extraDataSchema = z.object({
    companyName: z.string().max(300).optional(),
    services: z.string().max(4000).optional(),
    links: z.string().max(2000).optional(),
    pricing: z.string().max(4000).optional(),
    script: z.string().max(20000, "Скрипт продаж слишком длинный — максимум 20 000 символов").optional(),
    // Объединённое поле «адреса/филиалы и время работы»: филиал — график,
    // по строке на филиал. Хранится целиком в profile.hours.
    branches: z.string().max(3000).optional(),
    restrictions: z.string().max(2000).optional()
  });
  app.post("/agent/extra-data", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    const body = extraDataSchema.parse(request.body);
    const profile = await ensureAgentProfile(agent.id);

    const splitLines = (s?: string) =>
      (s ?? "").split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);

    // Семантика «пустое поле = нечего сказать, не трогаем» (как в enrichment).
    // Форма шлёт ВСЕ поля всегда, незаполненные — пустой строкой; писать их в
    // patch нельзя: mergeProfile спредит ...patch без ??-защиты и пустое значение
    // затёрло бы уже собранный профиль (services/pricing/hours/...).
    const patch: Partial<typeof profile> = {};
    if (body.companyName !== undefined && body.companyName.trim()) patch.businessName = body.companyName.trim();
    if (body.services !== undefined) {
      const list = splitLines(body.services);
      if (list.length > 0) patch.servicesList = list;
    }
    if (body.pricing !== undefined && body.pricing.trim()) patch.pricingPolicy = body.pricing.trim();
    if (body.branches !== undefined && body.branches.trim()) {
      // Филиалы и график — одно поле, чтобы в промпте адрес и часы каждого
      // филиала не разносились по разным секциям. Старый addressPolicy
      // очищаем ТОЛЬКО при непустых филиалах: его содержимое переехало в
      // объединённое поле (см. префилл). Пустые филиалы addressPolicy не трогают.
      patch.hours = body.branches.trim();
      patch.addressPolicy = "";
    }
    if (body.restrictions !== undefined) {
      const list = splitLines(body.restrictions);
      if (list.length > 0) patch.notAllowed = list;
    }
    // Ссылки и скрипт складываем в notes/integrations как доп-контекст.
    const noteParts: string[] = [];
    if (body.links) noteParts.push(`Ссылки: ${body.links.trim()}`);
    if (body.script) noteParts.push(`Скрипт/сценарий: ${body.script.trim()}`);
    if (noteParts.length > 0) patch.notes = noteParts.join("\n");

    const merged = mergeProfile(profile, patch);
    await prisma.businessProfile.upsert({
      where: { agentId: agent.id },
      update: { data: merged },
      create: { agentId: agent.id, data: merged }
    });

    let assistantText: string | undefined;
    try {
      const existingPrompt = await prisma.promptVersion.findFirst({
        where: { agentId: agent.id },
        orderBy: { createdAt: "desc" }
      });
      const currentPrompt = existingPrompt?.content || agent.currentPrompt || buildFallbackPrompt(merged);
      const formData = Object.fromEntries(
        Object.entries(body).flatMap(([key, value]) =>
          typeof value === "string" && value.trim().length > 0 ? [[key, value.trim()]] as const : []
        )
      ) as Record<string, string>;

      if (Object.keys(formData).length > 0 && currentPrompt.trim().length > 0) {
        const result = await applyEnrichment({
          currentPrompt,
          formData,
          telemetry: buildLlmTelemetry({
            route: "enrichment",
            userId: agent.userId ?? null,
            agentId: agent.id
          })
        });
        if (result.newPrompt !== currentPrompt && result.newPrompt.trim().length > 80) {
          await savePromptVersion(agent.id, result.newPrompt, "enrichment");
        }
        assistantText = result.assistantText;
      }
    } catch (err) {
      request.log.warn({ err }, "/agent/extra-data enrichment failed");
    }

    return { ok: true, businessProfile: merged, ...(assistantText ? { assistantText } : {}) };
  });

  // ── Фича «бот в стиле владельца»: загрузка диалогов, статус анализа, сброс ──
  //
  // Файлы шлём как массив {filename, content} в JSON (текст экспортов), чтобы не
  // тянуть multipart-плагин (как /transcribe с base64). Парсинг — синхронно здесь
  // (дёшево), а долгий LLM-анализ уходит в очередь style:analyze (apps/jobs).

  // Идёт ли прогон анализа прямо сейчас (queued/analyzing/aggregating) — новый
  // запуск в это окно затёр бы буфер эпизодов активной задачи, а add с тем же
  // jobId был бы no-op. Роуты загрузки в таком случае отвечают 409.
  const STYLE_RUNNING_STATUSES = ["queued", "analyzing", "aggregating"];
  async function isStyleAnalysisRunning(client: typeof prisma, agentId: string): Promise<boolean> {
    const row = await client.styleAnalysis.findUnique({
      where: { agentId },
      select: { status: true }
    });
    return Boolean(row && STYLE_RUNNING_STATUSES.includes(row.status));
  }

  // Ставит задачу анализа. removeOnFail: true критично: без него упавшая задача
  // остаётся в failed-set (дефолт очереди — до 7 дней), и повторный add с тем же
  // jobId `style:<agentId>` молча игнорируется — перезапуск был бы невозможен.
  async function enqueueStyleAnalysis(agentId: string, clearHistoryOnSuccess = false): Promise<void> {
    await getStyleAnalyzeQueue().add(
      "style-analyze",
      { agentId, ...(clearHistoryOnSuccess ? { clearHistoryOnSuccess } : {}) },
      { jobId: `style:${agentId}`, attempts: 1, removeOnComplete: true, removeOnFail: true }
    );
  }

  const styleDialoguesSchema = z.object({
    // Как владелец подписан в .txt-чатах (для JSON-дампа wtsexporter не нужно).
    ownerName: z.string().max(200).optional(),
    files: z
      .array(
        z.object({
          filename: z.string().max(300),
          content: z.string().max(5_000_000) // ~5 МБ на файл
        })
      )
      .min(1)
      .max(600)
  });
  app.post("/agent/style-dialogues", {
    // Экспорты диалогов бывают крупными (много чатов) — поднимаем лимит тела
    // с дефолтных 1 МБ. Реальный предохранитель размера — этот bodyLimit;
    // лимиты схемы (600×5 МБ) допускают заведомо больше и до тела не доходят.
    bodyLimit: 30 * 1024 * 1024
  }, async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    const body = styleDialoguesSchema.parse(request.body);

    // Не запускаем новый прогон поверх идущего: перезапись episodes отняла бы у него
    // ввод, а jobId занят активной задачей (add был бы no-op). Просим дождаться.
    if (await isStyleAnalysisRunning(prisma, agent.id)) {
      return reply.code(409).send({ error: "analysis_running", message: "Анализ уже идёт — дождитесь завершения." });
    }

    // Парсим все файлы в единый пул эпизодов (формат определяется по имени/содержимому).
    const episodes: DialogueEpisode[] = [];
    for (const file of body.files) {
      const parsed = parseDialogueSource(file.content, {
        filename: file.filename,
        chatLabel: file.filename,
        ...(body.ownerName ? { ownerName: body.ownerName } : {})
      });
      episodes.push(...parsed);
    }
    if (episodes.length === 0) {
      return reply.code(422).send({ error: "no_episodes", message: "Не удалось разобрать диалоги из файлов." });
    }

    // Сохраняем эпизоды в буфер + ставим задачу. Идемпотентно перезаписываем прошлый прогон.
    await prisma.styleAnalysis.upsert({
      where: { agentId: agent.id },
      update: {
        status: "queued",
        stage: "queued",
        ownerName: body.ownerName ?? "",
        totalEpisodes: episodes.length,
        processedEpisodes: 0,
        error: null,
        episodes
      },
      create: {
        agentId: agent.id,
        status: "queued",
        stage: "queued",
        ownerName: body.ownerName ?? "",
        totalEpisodes: episodes.length,
        episodes
      }
    });

    await enqueueStyleAnalysis(agent.id);

    return { ok: true, totalEpisodes: episodes.length };
  });

  app.get("/agent/style-status", async (request, reply) => {
    const agent = await getCurrentAgent(request, reply);
    if (!agent) return { status: "none", hasStyle: false };
    const [row, profile] = await Promise.all([
      prisma.styleAnalysis.findUnique({ where: { agentId: agent.id } }),
      prisma.businessProfile.findUnique({ where: { agentId: agent.id } })
    ]);
    const parsed = profile ? businessProfileSchema.parse(profile.data) : null;
    const hasStyle = Boolean(parsed?.styleGuide && parsed.styleGuide.trim());
    return {
      status: row?.status ?? "none",
      stage: row?.stage ?? "",
      totalEpisodes: row?.totalEpisodes ?? 0,
      processedEpisodes: row?.processedEpisodes ?? 0,
      error: row?.error ?? null,
      hasStyle,
      styleGuidePreview: hasStyle ? (parsed?.styleGuide ?? "").slice(0, 600) : null
    };
  });

  app.delete("/agent/style", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    // Во время прогона удалять StyleAnalysis нельзя: идущая задача обновляет эту
    // строку в onProgress и упадёт с P2025 (а джоба уйдёт в failed).
    if (await isStyleAnalysisRunning(prisma, agent.id)) {
      return reply.code(409).send({ error: "analysis_running", message: "Анализ идёт — сбросить можно после завершения." });
    }
    await clearStyle(prisma, agent.id);
    return { ok: true };
  });

  // Продуктовый источник: список личных чатов, захваченных из WhatsApp history-sync,
  // + состояние захвата (согласие/прогресс синка) для статус-бара в UI.
  app.get("/agent/style-history-chats", async (request, reply) => {
    const agent = await getCurrentAgent(request, reply);
    if (!agent) {
      return { chats: [], capture: false, syncStatus: "idle", progress: 0, connected: false };
    }
    const [chats, conn] = await Promise.all([
      prisma.waHistoryChat.findMany({
        where: { agentId: agent.id },
        orderBy: { messageCount: "desc" },
        select: { waChatId: true, label: true, messageCount: true, selected: true }
      }),
      prisma.waConnection.findUnique({
        where: { agentId: agent.id },
        select: {
          status: true,
          styleHistoryCapture: true,
          styleHistoryStatus: true,
          styleHistoryProgress: true,
          styleHistorySyncedAt: true
        }
      })
    ]);
    return {
      chats,
      capture: conn?.styleHistoryCapture ?? false,
      syncStatus: conn?.styleHistoryStatus ?? "idle",
      progress: conn?.styleHistoryProgress ?? 0,
      syncedAt: conn?.styleHistorySyncedAt ?? null,
      connected: conn?.status === "connected"
    };
  });

  // Включить захват личной истории из WhatsApp (явное согласие владельца). Ставит
  // флаг и переподключает сессию, чтобы WhatsApp заново прислал history-sync —
  // только так можно подтянуть переписку после уже выполненного подключения.
  app.post("/agent/style-history-enable", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    const conn = await prisma.waConnection.findUnique({
      where: { agentId: agent.id },
      select: { status: true }
    });
    if (!conn || conn.status !== "connected") {
      return reply.code(409).send({
        error: "not_connected",
        message: "Сначала подключите WhatsApp, затем включите сбор истории."
      });
    }
    await prisma.waConnection.update({
      where: { agentId: agent.id },
      data: {
        styleHistoryCapture: true,
        styleHistoryStatus: "syncing",
        styleHistoryProgress: 0,
        styleHistorySyncedAt: null
      }
    });
    // Переподключаем: stop → start с флагом захвата. Best-effort — если воркер
    // недоступен, флаг всё равно применится при следующем коннекте.
    try {
      await stopWorkerConnection(agent.id);
      await startWorkerConnection(agent.id, { styleHistoryCapture: true });
    } catch (err) {
      request.log.warn({ err, agentId: agent.id }, "style-history-enable: worker reconnect failed");
    }
    return { ok: true };
  });

  // Отозвать согласие: выключить захват. Уже собранный буфер чистим (личную
  // переписку без активного согласия не храним).
  app.post("/agent/style-history-disable", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    await prisma.waConnection.updateMany({
      where: { agentId: agent.id },
      data: { styleHistoryCapture: false, styleHistoryStatus: "idle", styleHistoryProgress: 0 }
    });
    await prisma.waHistoryChat.deleteMany({ where: { agentId: agent.id } });
    // Флаг у воркера обновится при следующем (пере)подключении; принудительно не рвём.
    return { ok: true };
  });

  // Запуск анализа по выбранным из истории чатам: конвертируем в эпизоды, кладём в
  // буфер StyleAnalysis и ставим задачу. Буфер истории НЕ удаляем здесь — только
  // после успешного анализа (clearHistoryOnSuccess), иначе при ошибке прогона ввод
  // теряется безвозвратно (история приходит лишь при переподключении номера).
  app.post("/agent/style-history-analyze", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    const body = z.object({ waChatIds: z.array(z.string().min(1)).min(1).max(2000) }).parse(request.body);

    if (await isStyleAnalysisRunning(prisma, agent.id)) {
      return reply.code(409).send({ error: "analysis_running", message: "Анализ уже идёт — дождитесь завершения." });
    }

    const rows = await prisma.waHistoryChat.findMany({
      where: { agentId: agent.id, waChatId: { in: body.waChatIds } }
    });
    const episodes: DialogueEpisode[] = [];
    for (const row of rows) {
      const messages = (row.messages as HistoryMessage[] | null) ?? [];
      episodes.push(
        ...parseHistoryMessages(messages, { chatLabel: row.label || row.waChatId })
      );
    }
    if (episodes.length === 0) {
      return reply.code(422).send({ error: "no_episodes", message: "В выбранных чатах нет пригодных диалогов." });
    }

    await prisma.styleAnalysis.upsert({
      where: { agentId: agent.id },
      update: {
        status: "queued",
        stage: "queued",
        totalEpisodes: episodes.length,
        processedEpisodes: 0,
        error: null,
        episodes
      },
      create: {
        agentId: agent.id,
        status: "queued",
        stage: "queued",
        totalEpisodes: episodes.length,
        episodes
      }
    });
    await enqueueStyleAnalysis(agent.id, true);

    return { ok: true, totalEpisodes: episodes.length };
  });

  // Голосовой ввод: распознавание речи (STT). Аудио приходит как base64 в JSON,
  // чтобы не тянуть multipart-плагин. Лимит размера защищает от больших файлов.
  const transcribeSchema = z.object({
    audioBase64: z.string().min(1).max(8_000_000), // ~6 МБ аудио в base64
    mimeType: z.string().max(100).optional(),
    language: z.string().max(10).optional()
  });
  app.post("/transcribe", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const user = await getUserFromRequest(request);
    // Доступно и гостю (для тест-чата), и авторизованному.
    const body = transcribeSchema.parse(request.body);
    try {
      const buffer = Buffer.from(body.audioBase64, "base64");
      const text = await transcribeAudio(buffer, {
        mimeType: body.mimeType ?? "audio/webm",
        filename: "voice.webm",
        language: body.language ?? "ru"
      });
      return { ok: true, text };
    } catch (err) {
      request.log.error({ err, userId: user?.id ?? null }, "transcribe failed");
      reply.code(502);
      return { ok: false, error: "Не удалось распознать речь" };
    }
  });

  // Прогресс настройки бота для текущей сессии (работает и для гостя через
  // сессионного агента). Используется гостевой шапкой, чтобы решить, когда
  // показывать CTA «Привязать WhatsApp»: промпт собран, сделано >=2 правок,
  // WhatsApp ещё не подключён.
  app.get("/agent/progress", async (request, reply) => {
    const agent = await getCurrentAgent(request, reply);
    if (!agent) {
      return { hasPrompt: false, correctionsCount: 0, waConnected: false };
    }
    const [promptVersionsCount, correctionsCount, wa] = await Promise.all([
      prisma.promptVersion.count({ where: { agentId: agent.id } }),
      prisma.promptVersion.count({ where: { agentId: agent.id, source: "correction" } }),
      prisma.waConnection.findUnique({
        where: { agentId: agent.id },
        select: { status: true }
      })
    ]);
    return {
      hasPrompt: promptVersionsCount > 0,
      correctionsCount,
      waConnected: wa?.status === "connected"
    };
  });

  // Глобальный «выключатель» бота для текущего агента пользователя.
  // Используется на странице «Диалоги»: пауза/возобновление ответов WA-бота.
  // Не трогает Status — это разные оси (active/draft/archived vs paused/live).
  app.patch("/agent/bot-state", {
    config: {
      rateLimit: { max: 30, timeWindow: "1 minute" }
    }
  }, async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { success: false, message: "Authentication required" };
    }

    const body = botStateBodySchema.parse(request.body ?? {});

    const agent = await prisma.agent.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" }
    });
    if (!agent) {
      reply.code(404);
      return { success: false, message: "Agent not found" };
    }

    const updated = await prisma.agent.update({
      where: { id: agent.id },
      data: { botEnabled: body.botEnabled }
    });

    return {
      success: true,
      agentId: updated.id,
      botEnabled: updated.botEnabled
    };
  });

  app.get("/agent/versions", async (request, reply) => {
    const agent = await getCurrentAgent(request, reply);
    if (!agent) {
      return [];
    }
    const versions = await prisma.promptVersion.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: "desc" }
    });

    return versions;
  });

  app.post("/agent/chat", {
    config: {
      // LLM-вызов = деньги + время. На юзера: 30 ходов в минуту достаточно
      // для живого диалога; больше — это уже автоматизация/абуз.
      rateLimit: { max: 30, timeWindow: "1 minute" }
    }
  }, async (request, reply) => {
    const body = chatBodySchema.parse(request.body);
    const { session, agent } = await buildWriteSessionView(request, reply);
    const profile = await ensureAgentProfile(agent.id);

    const { message, userParts } = await resolveChatInput(body);

    await prisma.builderMessage.create({
      data: {
        agentId: agent.id,
        role: "user",
        content: message,
        parts: jsonInput(userParts)
      }
    });

    const currentHistory = await prisma.builderMessage.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: "desc" },
      take: 30
    });
    currentHistory.reverse();

    const stream = startSseStream(request, reply);

    try {
      const turn = await buildBuilderTurn(
        profile,
        message,
        currentHistory.map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: item.content
        })),
        buildLlmTelemetry({
          route: "builder",
          userId: agent.userId ?? null,
          agentId: agent.id
        })
      );

      await typeTokens(stream, turn.assistantText, { perChunkMs: 22, targetChunks: 140 });

      const mergedProfile = mergeProfile(profile, turn.profilePatch);
      await prisma.businessProfile.upsert({
        where: { agentId: agent.id },
        update: { data: mergedProfile },
        create: { agentId: agent.id, data: mergedProfile }
      });

      const existingPrompt = await prisma.promptVersion.findFirst({
        where: { agentId: agent.id },
        orderBy: { createdAt: "desc" }
      });

      // Каркас воронки билдер «болтает» между ходами онбординга. Разрешаем
      // перезапись, пока промпта ещё нет (create не случился) — тогда в БД
      // осядет каркас ФИНАЛЬНОГО хода билдера. После появления промпта —
      // фиксируем, чтобы рантайм не прыгал.
      if (turn.carcass && (!agent.carcass || !existingPrompt)) {
        await prisma.agent.update({
          where: { id: agent.id },
          data: { carcass: turn.carcass }
        });
      }

      // Денормализуем РОЛЬ бота на Agent для быстрого чтения в рантайме.
      // Независимо от create-гейта: модель определяется на шаге 1 воронки,
      // задолго до сбора базы, и может меняться по ходу онбординга.
      if (turn.botModel && turn.botModel !== agent.botModel) {
        await prisma.agent.update({
          where: { id: agent.id },
          data: { botModel: turn.botModel }
        });
      }

      const profileReady = isProfileReadyForPrompt(mergedProfile);
      let promptDraft = existingPrompt?.content ?? "";
      let promptCard: PromptCard | undefined;

      // LLM сам решает, что происходит с промптом этим ходом.
      // skip  — карточку не показываем, версию не создаём.
      // create — первая большая версия (только если existingPrompt отсутствует).
      // edit  — обновление поверх существующей.
      //
      // Safety net: если LLM 6+ ходов держит skip, а в профиле уже есть niche
      // (и нет существующего промпта) — форсим create на ходе.
      const llmEvent = turn.promptEvent ?? "skip";
      const userTurnsTotal = await prisma.builderMessage.count({
        where: { agentId: agent.id, role: "user" }
      });

      let effectiveEvent: "skip" | "create" | "edit" = llmEvent;
      if (effectiveEvent === "create" && existingPrompt) {
        // LLM перепутал — считаем как edit, чтобы не плодить дубли первой версии.
        effectiveEvent = "edit";
      }
      if (effectiveEvent === "edit" && !existingPrompt) {
        // Нечего обновлять без базовой версии — становимся create.
        effectiveEvent = "create";
      }
      if (
        effectiveEvent === "skip" &&
        !existingPrompt &&
        userTurnsTotal >= 6 &&
        Boolean(mergedProfile.niche || mergedProfile.businessName)
      ) {
        effectiveEvent = "create";
      }

      // ГЕЙТ БАЗЫ (v3): не создаём промпт, пока не собраны услуги + гео + цель лида.
      // Конфликт с анти-зависанием/safety-net: если create форсирован к 6+ ходу,
      // НЕ блокируем — добиваем недостающую базу плейсхолдерами "не указано"
      // (только в памяти, профиль не перезаписываем), чтобы baseFilled стал
      // честно true и упрямый владелец не залип навсегда. Преждевременный
      // "давай тест" на 2-м ходу всё ещё блокируется.
      const forcingCreate = effectiveEvent === "create" && userTurnsTotal >= 6;
      if (forcingCreate) {
        mergedProfile.geography ||= "не указано";
        mergedProfile.leadGoal ||= "не указано";
        if (!(mergedProfile.servicesList?.length)) {
          mergedProfile.servicesList = ["не указано"];
        }
      }
      const baseFilled =
        (mergedProfile.servicesList?.length ?? 0) > 0 &&
        !!mergedProfile.geography &&
        !!mergedProfile.leadGoal;
      if (effectiveEvent === "create" && !baseFilled) {
        effectiveEvent = existingPrompt ? "edit" : "skip";
      }

      if (effectiveEvent !== "skip") {
        const candidatePrompt = turn.promptDraft && turn.promptDraft.trim().length > 80
          ? turn.promptDraft
          : buildFallbackPrompt(mergedProfile);

        const hasChange = !existingPrompt || existingPrompt.content !== candidatePrompt;
        if (hasChange) {
          promptDraft = candidatePrompt;
          const previousContent = existingPrompt?.content ?? null;
          const summary = turn.promptSummary && turn.promptSummary.trim().length > 0
            ? turn.promptSummary.trim()
            : undefined;
          promptCard = buildPromptCard(previousContent, promptDraft, {
            changeKind: effectiveEvent === "create" ? "create" : "edit",
            ...(summary ? { changeSummary: summary } : {})
          });
          await savePromptVersion(
            agent.id,
            promptDraft,
            effectiveEvent === "create" ? "create" : "edit"
          );
        }
      }

      const assistantParts = toAssistantParts(turn.assistantText, turn.actionButton, promptCard);
      await prisma.builderMessage.create({
        data: {
          agentId: agent.id,
          role: "assistant",
          content: turn.assistantText,
          parts: jsonInput(assistantParts)
        }
      });

      await prisma.session.update({
        where: { id: session.id },
        data: {
          promptDraft,
          readyToFinalize: profileReady ? Boolean(turn.readyToTest) : false,
          isGenerating: false
        }
      });
      if (promptDraft) {
        await prisma.agent.update({
          where: { id: agent.id },
          data: {
            currentPrompt: promptDraft,
            readyToFinalize: profileReady ? Boolean(turn.readyToTest) : false
          }
        });
      }

      stream.writeEvent("done", { ...turn, promptDraft, assistantParts, promptCard });
    } catch (error) {
      request.log.error({ err: error }, "/agent/chat failed");
      stream.writeEvent("error", {
        message: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      stream.end();
    }
  });

  app.post("/agent/correct", async (request, reply) => {
    const { messageId, correction } = correctBodySchema.parse(request.body);
    const { agent } = await buildWriteSessionView(request, reply);
    const profile = await ensureAgentProfile(agent.id);

    const existingPrompt = await prisma.promptVersion.findFirst({
      where: { agentId: agent.id },
      orderBy: { createdAt: "desc" }
    });
    const currentPrompt = existingPrompt?.content || agent.currentPrompt || buildFallbackPrompt(profile);

    let badBotMessage: string | undefined;
    let userMessage: string | undefined;
    if (messageId) {
      const target = await prisma.testMessage.findUnique({ where: { id: messageId } });
      if (target?.role === "assistant") {
        badBotMessage = target.content;
        const prev = await prisma.testMessage.findFirst({
          where: { agentId: agent.id, role: "user", createdAt: { lt: target.createdAt } },
          orderBy: { createdAt: "desc" }
        });
        userMessage = prev?.content;
      }
    }

    const result = await applyPromptCorrection({
      currentPrompt,
      correctionText: correction,
      ...(badBotMessage !== undefined ? { badBotMessage } : {}),
      ...(userMessage !== undefined ? { userMessage } : {}),
      profile,
      telemetry: buildLlmTelemetry({
        route: "correction-builder",
        userId: agent.userId ?? null,
        agentId: agent.id
      })
    });

    // Смена РОЛИ бота (correctionType="model"): денормализуем новую модель на Agent,
    // чтобы рантайм подхватил роль из authoritative-колонки.
    if (result.newBotModel) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { botModel: result.newBotModel }
      });
    }

    const promptCard = buildPromptCard(currentPrompt, result.newPrompt, {
      changeKind: "correction",
      changeSummary: result.changeSummary,
      ...(result.correctionType ? { correctionType: result.correctionType } : {}),
      ...(result.sectionEdited ? { sectionEdited: result.sectionEdited } : {})
    });
    await savePromptVersion(agent.id, result.newPrompt, "correction", {
      correctionType: result.correctionType ?? null,
      sectionEdited: result.sectionEdited ?? null
    });

    await prisma.builderMessage.create({
      data: {
        agentId: agent.id,
        role: "user",
        content: `Правка: ${correction}`,
        parts: jsonInput([{ type: "text", text: correction }])
      }
    });
    await prisma.builderMessage.create({
      data: {
        agentId: agent.id,
        role: "assistant",
        content: result.assistantText,
        parts: jsonInput(toAssistantParts(result.assistantText, undefined, promptCard))
      }
    });

    return {
      ok: true,
      assistantText: result.assistantText,
      promptDraft: result.newPrompt,
      changeSummary: result.changeSummary,
      correctionType: result.correctionType ?? "other",
      sectionEdited: result.sectionEdited ?? "",
      promptCard
    };
  });

  app.get("/test-chat/history", async (request, reply) => {
    const agent = await getCurrentAgent(request, reply);
    if (!agent) {
      return [];
    }
    const messages = await prisma.testMessage.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: "asc" }
    });
    return messages;
  });

  app.post("/test-chat/reset", async (request, reply) => {
    const { session, agent } = await buildWriteSessionView(request, reply);
    await prisma.testMessage.deleteMany({ where: { agentId: agent.id } });
    await prisma.session.update({
      where: { id: session.id },
      data: {
        testBotHistory: [],
        // Сбрасываем буфер потребности, иначе после reset бот «помнит» старую цель.
        detectedNeed: null,
        detectedName: null
      }
    });
    return { ok: true };
  });

  app.post("/test-chat/correct", async (request, reply) => {
    const { messageId, correction } = correctBodySchema.parse(request.body);
    const { session, agent } = await buildWriteSessionView(request, reply);
    const profile = await ensureAgentProfile(agent.id);

    const existingPrompt = await prisma.promptVersion.findFirst({
      where: { agentId: agent.id },
      orderBy: { createdAt: "desc" }
    });
    const currentPrompt = existingPrompt?.content || agent.currentPrompt || buildFallbackPrompt(profile);

    let badBotMessage: string | undefined;
    let userMessage: string | undefined;
    let targetMessage: Awaited<ReturnType<typeof prisma.testMessage.findUnique>> | null = null;
    if (messageId) {
      targetMessage = await prisma.testMessage.findUnique({ where: { id: messageId } });
      if (targetMessage?.role === "assistant") {
        badBotMessage = targetMessage.content;
        const prev = await prisma.testMessage.findFirst({
          where: { agentId: agent.id, role: "user", createdAt: { lt: targetMessage.createdAt } },
          orderBy: { createdAt: "desc" }
        });
        userMessage = prev?.content;
      }
    }

    const result = await applyPromptCorrection({
      currentPrompt,
      correctionText: correction,
      ...(badBotMessage !== undefined ? { badBotMessage } : {}),
      ...(userMessage !== undefined ? { userMessage } : {}),
      profile,
      telemetry: buildLlmTelemetry({
        route: "correction-test",
        userId: agent.userId ?? null,
        agentId: agent.id
      })
    });

    // Смена РОЛИ бота (correctionType="model"): денормализуем новую модель на Agent,
    // чтобы рантайм подхватил роль из authoritative-колонки.
    if (result.newBotModel) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { botModel: result.newBotModel }
      });
    }

    const promptCard = buildPromptCard(currentPrompt, result.newPrompt, {
      changeKind: "correction",
      changeSummary: result.changeSummary,
      ...(result.correctionType ? { correctionType: result.correctionType } : {}),
      ...(result.sectionEdited ? { sectionEdited: result.sectionEdited } : {})
    });
    await savePromptVersion(agent.id, result.newPrompt, "correction", {
      correctionType: result.correctionType ?? null,
      sectionEdited: result.sectionEdited ?? null
    });

    if (targetMessage?.role === "assistant") {
      const existingParts = Array.isArray(targetMessage.parts) ? (targetMessage.parts as unknown[]) : [];
      await prisma.testMessage.update({
        where: { id: targetMessage.id },
        data: {
          parts: jsonInput([
            ...existingParts,
            { type: "stale_marker", stale: true }
          ] as Array<Record<string, unknown>>)
        }
      });
    }

    await prisma.testMessage.create({
      data: {
        agentId: agent.id,
        role: "assistant",
        content: result.assistantText || result.changeSummary || "Промпт обновлён",
        parts: jsonInput([
          { type: "text", text: result.assistantText || result.changeSummary || "Промпт обновлён" },
          ...(promptCard ? [{ type: "prompt_card", prompt_card: promptCard }] : [])
        ])
      }
    });

    // Дублируем результат правки в чат настройки, чтобы изменения промпта
    // были видны в обоих лентах. Лента билдера — это «источник правды»
    // для финального промпта, поэтому там должно остаться зелёное системное
    // сообщение «Промпт обновлён» с тем же summary, что юзер видел в тесте.
    const builderText = result.assistantText || result.changeSummary || "Промпт обновлён";
    await prisma.builderMessage.create({
      data: {
        agentId: agent.id,
        role: "user",
        content: `Правка в тесте: ${correction}`,
        parts: jsonInput([{ type: "text", text: correction }])
      }
    });
    await prisma.builderMessage.create({
      data: {
        agentId: agent.id,
        role: "assistant",
        content: builderText,
        parts: jsonInput([
          { type: "text", text: builderText },
          ...(promptCard ? [{ type: "prompt_card", prompt_card: promptCard }] : [])
        ])
      }
    });

    let regenerated: { content: string; id: string } | null = null;
    if (userMessage) {
      const history = await prisma.testMessage.findMany({
        where: { agentId: agent.id, createdAt: { lt: targetMessage?.createdAt ?? new Date() } },
        orderBy: { createdAt: "desc" },
        take: 16
      });
      history.reverse();
      try {
        // Подмешиваем РОЛЬ/КАРКАС из authoritative-источника (Agent). Если правка
        // только что сменила модель (newBotModel) — берём её, чтобы регенерация
        // показала ответ под новую роль. detectedNeed читаем (чтобы учесть
        // известную потребность), но на этом пути НЕ пишем — это реплей, не новый
        // ход клиента, и needChanged мог бы ложно сработать.
        const regenProfile = {
          ...profile,
          carcass: (agent.carcass ?? null) as Carcass | null,
          botModel: (result.newBotModel ?? agent.botModel ?? null) as
            | "admin" | "consultant" | "support" | "qualifier" | "salesman" | null
        } as typeof profile;
        const turn = await buildRuntimeTurn(
          regenProfile,
          userMessage,
          history
            .slice(0, -1)
            .map((item) => ({
              role: item.role === "assistant" ? "assistant" : "user",
              content: item.content
            })),
          {
            systemOverride: result.newPrompt,
            detectedNeed: session.detectedNeed,
            detectedName: session.detectedName,
            telemetry: buildLlmTelemetry({
              route: "test-regenerate",
              userId: agent.userId ?? null,
              agentId: agent.id
            })
          }
        );
        const created = await prisma.testMessage.create({
          data: {
            agentId: agent.id,
            role: "assistant",
            content: turn.reply,
            parts: jsonInput([
              ...toAssistantParts(turn.reply, turn.actionButton),
              { type: "regenerated_marker", text: "regenerated" }
            ])
          }
        });
        regenerated = { content: turn.reply, id: created.id };
      } catch (error) {
        request.log.error({ err: error }, "/test-chat/correct regenerate failed");
      }
    }

    return {
      ok: true,
      assistantText: result.assistantText,
      promptDraft: result.newPrompt,
      changeSummary: result.changeSummary,
      correctionType: result.correctionType ?? "other",
      sectionEdited: result.sectionEdited ?? "",
      promptCard,
      staleMessageId: targetMessage?.id ?? null,
      regenerated
    };
  });

  app.post("/test-chat/chat", async (request, reply) => {
    const body = chatBodySchema.parse(request.body);
    const { session, agent } = await buildWriteSessionView(request, reply);
    const profile = await ensureAgentProfile(agent.id);

    const { message, userParts } = await resolveChatInput(body);

    await prisma.testMessage.create({
      data: {
        agentId: agent.id,
        role: "user",
        content: message,
        parts: jsonInput(userParts)
      }
    });

    const history = await prisma.testMessage.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: "desc" },
      take: 16
    });
    history.reverse();

    const stream = startSseStream(request, reply);

    try {
      // РОЛЬ/КАРКАС берём из authoritative-источника (Agent), а не из профиля,
      // чтобы envelope не прочитал устаревшее значение из BusinessProfile.data.
      const runtimeProfile = {
        ...profile,
        carcass: (agent.carcass ?? null) as Carcass | null,
        botModel: (agent.botModel ?? null) as
          | "admin" | "consultant" | "support" | "qualifier" | "salesman" | null
      } as typeof profile;
      const turn = await buildRuntimeTurn(
        runtimeProfile,
        message,
        history
          .slice(0, -1)
          .map((item) => ({
            role: item.role === "assistant" ? "assistant" : "user",
            content: item.content
          })),
        {
          systemOverride: agent.currentPrompt,
          detectedNeed: session.detectedNeed,
          detectedName: session.detectedName,
          telemetry: buildLlmTelemetry({
            route: "test-chat",
            userId: agent.userId ?? null,
            agentId: agent.id
          })
        }
      );

      await typeTokens(stream, turn.reply, { perChunkMs: 22, targetChunks: 140 });

      await prisma.testMessage.create({
        data: {
          agentId: agent.id,
          role: "assistant",
          content: turn.reply,
          parts: jsonInput(toAssistantParts(turn.reply, turn.actionButton))
        }
      });

      // Буфер потребности: needChanged-перезапись проверяем ПЕРВОЙ, иначе при
      // уже заполненном detectedNeed смена запроса не записалась бы.
      {
        let nextNeed: string | null = null;
        if (turn.needChanged && turn.extractedNeed) {
          nextNeed = turn.extractedNeed;
        } else if (!session.detectedNeed && turn.extractedNeed) {
          nextNeed = turn.extractedNeed;
        }
        if (nextNeed && nextNeed !== session.detectedNeed) {
          await prisma.session.update({
            where: { id: session.id },
            data: { detectedNeed: nextNeed }
          });
        }
      }

      {
        let nextName: string | null = null;
        if (turn.extractedName) {
          nextName = turn.extractedName;
        }
        if (nextName && nextName !== session.detectedName) {
          await prisma.session.update({
            where: { id: session.id },
            data: { detectedName: nextName }
          });
        }
      }

      if (turn.shouldHandoff) {
        // chatId фиксирован, чтобы все handoff из теста сливались в одну
        // и ту же conversation, а не плодили мусор. Эта conversation
        // отфильтровывается в /chats и /leads (см. TEST_CONVERSATION_CHAT_ID).
        const conversation = await getOrCreateConversation(
          agent.id,
          TEST_CONVERSATION_CHAT_ID,
          "Test client"
        );
        await writeLeadIfNeeded(agent.id, conversation.id, turn.summary || summarizeLead(profile, message), message, true, turn.handoffType ?? null);
      }

      stream.writeEvent("done", turn);
    } catch (error) {
      request.log.error({ err: error }, "/test-chat/chat failed");
      stream.writeEvent("error", {
        message: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      stream.end();
    }
  });

  app.get("/whatsapp/status", async (request, reply) => {
    const { agent } = await buildSessionView(request, reply);
    if (!agent) {
      return { agentId: null, connection: null, workerStatus: { status: "disconnected", qrText: null, qrDataUrl: null, workerSessionId: null, phone: null, lastSeenAt: null } };
    }
    const connection = await ensureWaConnection(agent.id);
    const dbFallback: Awaited<ReturnType<typeof getWorkerConnection>> = {
      status: connection.status,
      qrText: connection.qrText ?? null,
      qrDataUrl: (connection as { qrDataUrl?: string | null }).qrDataUrl ?? null,
      workerSessionId: connection.workerSessionId ?? null,
      phone: connection.phone ?? null,
      lastSeenAt: connection.lastSeenAt?.toISOString?.() ?? null
    };

    // КРИТИЧНО: если в БД явно «disconnected» (пользователь только что нажал
    // «Отключить»), БД — авторитетный источник. Worker может ещё держать
    // сессию в памяти и ответить status=connected, если DELETE до него
    // не дошёл (network blip, timeout). Тогда UI продолжал бы видеть
    // «Подключено» — это и был баг.
    if (connection.status === "disconnected") {
      // Заодно best-effort пинаем worker ещё раз, чтобы он догнал состояние
      // БД и снёс сессию у себя. Без await — нам ответ от него не нужен.
      void stopWorkerConnection(agent.id).catch(() => undefined);
      return { agentId: agent.id, connection, workerStatus: dbFallback };
    }

    let workerStatus = dbFallback;
    try {
      workerStatus = await getWorkerConnection(agent.id);
    } catch {
      // keep database fallback
    }

    return {
      agentId: agent.id,
      connection,
      workerStatus
    };
  });

  app.post("/whatsapp/qr", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    const connection = await ensureWaConnection(agent.id);

    // Если в worker'е уже висит pairing/qr-сессия от предыдущей попытки
    // (юзер переключился с «Кода» на «QR»), startWorkerConnection вернёт
    // тот же state без создания нового сокета — QR никогда не появится.
    // Гарантированно гасим её перед запросом QR.
    if (connection.status === "pairing" || connection.status === "qr" || connection.status === "error") {
      try {
        await stopWorkerConnection(agent.id);
      } catch (err) {
        request.log.warn({ err, agentId: agent.id }, "wa: pre-qr stop failed — continuing");
      }
    }

    // Сохраняем согласие на захват истории через рестарты подключения.
    const workerStatus = await startWorkerConnection(agent.id, {
      styleHistoryCapture: connection.styleHistoryCapture
    });

    await prisma.waConnection.upsert({
      where: { agentId: agent.id },
      update: {
        status: workerStatus.status,
        qrText: workerStatus.qrText ?? null,
        workerSessionId: workerStatus.workerSessionId ?? null,
        phone: workerStatus.phone ?? null,
        lastSeenAt: workerStatus.lastSeenAt ? new Date(workerStatus.lastSeenAt) : null
      },
      create: {
        agentId: agent.id,
        status: workerStatus.status,
        authState: {},
        qrText: workerStatus.qrText ?? null,
        workerSessionId: workerStatus.workerSessionId ?? null,
        phone: workerStatus.phone ?? null,
        lastSeenAt: workerStatus.lastSeenAt ? new Date(workerStatus.lastSeenAt) : null
      }
    });

    return {
      connection: connection,
      workerStatus
    };
  });

  app.get("/whatsapp/qr", async (request, reply) => {
    const { agent } = await buildSessionView(request, reply);
    if (!agent) {
      return { status: "disconnected", qrText: null, qrDataUrl: null, workerSessionId: null, phone: null, lastSeenAt: null };
    }
    try {
      const workerStatus = await getWorkerConnection(agent.id);
      return workerStatus;
    } catch (error) {
      reply.code(500);
      return {
        status: "error",
        qrText: error instanceof Error ? error.message : "Unknown worker error",
        qrDataUrl: null,
        workerSessionId: null,
        phone: null,
        lastSeenAt: null
      };
    }
  });

  // Pairing code (альтернатива QR): пользователь вводит номер, получает
  // 8-значный код, вводит его в WhatsApp → Linked Devices →
  // "Link with phone number instead".
  app.post("/whatsapp/pair", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    const { phone } = z.object({ phone: z.string().min(1) }).parse(request.body);

    const normalized = normalizeKzRuPhone(phone);
    if (!normalized) {
      reply.code(400);
      return { ok: false, error: "Введите номер в формате +7XXXXXXXXXX" };
    }
    // Baileys ждёт чистые цифры без "+".
    const digits = normalized.replace(/\D+/g, "");

    // Анти-абуз PRE-CHECK: для pairing-code flow номер известен заранее
    // (юзер сам его ввёл), поэтому проверяем claim ДО выдачи кода. Если
    // номер застолблён другим аккаунтом — не выдаём код вообще, юзер сразу
    // видит понятную ошибку. Это лучше, чем post-check в connection.open
    // (там WhatsApp уже привязывает устройство, и откат — задним числом).
    // Финальный post-check в worker'е остаётся как защита от подмены номера
    // и для QR-flow, где номер заранее неизвестен.
    const phoneHash = hashWaPhone(normalized);
    const existingClaim = await prisma.waPhoneClaim.findUnique({
      where: { phoneHash },
      select: { userId: true }
    });
    if (existingClaim && existingClaim.userId !== agent.userId) {
      reply.code(409);
      return {
        ok: false,
        error:
          "Этот номер WhatsApp уже привязан к другому аккаунту Jazu. " +
          "Один номер можно использовать только в одном аккаунте. " +
          "Если это ваш номер и нужно перенести, напишите в поддержку."
      };
    }

    try {
      const result = await pairWorkerConnection(agent.id, digits);

      // Запишем телефон сразу — даже если юзер потом не введёт код, у нас
      // будет привязка для отображения. Финальный статус прилетит через
      // /whatsapp/qr-update когда связь установится.
      await prisma.waConnection.upsert({
        where: { agentId: agent.id },
        update: { phone: normalized, status: "pairing", lastSeenAt: new Date() },
        create: {
          agentId: agent.id,
          phone: normalized,
          status: "pairing",
          authState: {},
          lastSeenAt: new Date()
        }
      });

      await recordAudit({
        event: "wa.pair_requested",
        userId: agent.userId ?? null,
        request,
        metadata: { agentId: agent.id, phone: normalized }
      });

      return { ok: true, code: result.code, phone: result.phone };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось получить код";
      reply.code(409);
      return { ok: false, error: message };
    }
  });

  app.delete("/whatsapp", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);

    // Worker — best-effort: если он недоступен (рестарт, network blip, 500),
    // мы ВСЁ РАВНО должны очистить локальную привязку, иначе пользователь
    // не сможет переподключить WhatsApp. Раньше throw отсюда не давал
    // дойти до wipe authState ниже — кнопка «Отключить» молча падала с 500.
    let workerStatus: Awaited<ReturnType<typeof stopWorkerConnection>> | null = null;
    let workerError: string | null = null;
    try {
      workerStatus = await stopWorkerConnection(agent.id);
    } catch (err) {
      workerError = err instanceof Error ? err.message : "Worker unavailable";
      request.log.warn({ err, agentId: agent.id }, "wa: worker stop failed — continuing with local cleanup");
      // Fire-and-forget retry: если worker оживёт через секунду, всё-таки
      // снесём сессию у него тоже. Если первый запрос упал по таймауту, а
      // второй пройдёт — это спасёт пользователя от «вечно подключён» в
      // /whatsapp/status (см. логику ниже про БД-авторитативность).
      setTimeout(() => {
        void stopWorkerConnection(agent.id).catch(() => undefined);
      }, 1500);
    }

    // КРИТИЧНО: при отключении вычищаем authState, иначе следующая попытка
    // (особенно pairing) подцепит старые creds и Baileys будет логиниться
    // как passive=true, что отбивается WhatsApp'ом как "Connection Failure".
    await prisma.waConnection.upsert({
      where: { agentId: agent.id },
      update: {
        status: "disconnected",
        qrText: null,
        qrDataUrl: null,
        workerSessionId: null,
        phone: null,
        authState: {},
        authStateUpdatedAt: new Date(),
        // Сбрасываем «отсечку»: следующая привязка должна поставить новую,
        // основанную на момент того нового подключения.
        botRespondsSince: null
      },
      create: {
        agentId: agent.id,
        status: "disconnected",
        authState: {},
        qrText: null,
        workerSessionId: null
      }
    });

    // Сбрасываем снимок «до-коннектных» чатов: следующая привязка снимет
    // новый снимок из свежего history-sync.
    await prisma.waPreConnectionChat.deleteMany({ where: { agentId: agent.id } });

    await recordAudit({
      event: "wa.disconnected",
      userId: agent.userId ?? null,
      request,
      metadata: { agentId: agent.id, workerError }
    });

    return {
      ok: true,
      workerStatus,
      ...(workerError ? { workerError } : {})
    };
  });

  // Called by WA worker to push current QR/status updates into the DB
  app.post("/whatsapp/qr-update", async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }

    const body = z.object({
      agentId: z.string().min(1),
      status: z.enum(["disconnected", "qr", "pairing", "connected", "error"]),
      qrText: z.string().nullable().optional(),
      qrDataUrl: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      workerSessionId: z.string().nullable().optional(),
      botRespondsSince: z.string().datetime().nullable().optional()
    }).parse(request.body);

    // botRespondsSince ставим ТОЛЬКО если в БД пусто (первая привязка после
    // disconnect). При авто-reconnect worker присылает тот же флаг, но мы
    // не хотим переписывать — иначе при каждом сетевом блипе бот «забывает»
    // с кем уже общался, и Conversation, созданные минуту назад, станут
    // «доконнектными».
    const existing = await prisma.waConnection.findUnique({
      where: { agentId: body.agentId },
      select: { botRespondsSince: true, status: true }
    });
    const newBotRespondsSince =
      body.botRespondsSince && !existing?.botRespondsSince
        ? new Date(body.botRespondsSince)
        : undefined;
    // Переход в connected (раньше был не connected) — это «привязка
    // завершена». Фиксируем как audit-событие (оно зеркалится в PostHog).
    const justConnected = body.status === "connected" && existing?.status !== "connected";

    await prisma.waConnection.upsert({
      where: { agentId: body.agentId },
      update: {
        status: body.status,
        qrText: body.qrText ?? null,
        qrDataUrl: body.qrDataUrl ?? null,
        workerSessionId: body.workerSessionId ?? null,
        phone: body.phone ?? null,
        lastSeenAt: new Date(),
        ...(newBotRespondsSince ? { botRespondsSince: newBotRespondsSince } : {})
      },
      create: {
        agentId: body.agentId,
        status: body.status,
        authState: {},
        qrText: body.qrText ?? null,
        qrDataUrl: body.qrDataUrl ?? null,
        workerSessionId: body.workerSessionId ?? null,
        phone: body.phone ?? null,
        lastSeenAt: new Date(),
        botRespondsSince: body.botRespondsSince ? new Date(body.botRespondsSince) : null
      }
    });

    if (justConnected) {
      // Подтягиваем владельца агента для distinctId в PostHog.
      const agent = await prisma.agent.findUnique({
        where: { id: body.agentId },
        select: { userId: true }
      });
      if (agent?.userId) {
        // whatsapp_connected — конверсия привлечения, считаем РОВНО раз на юзера.
        // Атомарный guard: updateMany по whatsappConnectedAt=null. Если строка
        // обновилась — это первый коннект → зеркалим в PostHog; реконнекты всё
        // равно пишем в AuditLog (безопасность/ops), но новой конверсии не плодят.
        let firstConnect = false;
        try {
          const marked = await prisma.user.updateMany({
            where: { id: agent.userId, whatsappConnectedAt: null },
            data: { whatsappConnectedAt: new Date() }
          });
          firstConnect = marked.count > 0;
        } catch { /* guard не критичен — audit-лог ниже пишем в любом случае */ }
        await recordAudit({
          event: "wa.connected",
          userId: agent.userId,
          request,
          metadata: { agentId: body.agentId, phone: body.phone ?? null },
          mirrorToPostHog: firstConnect
        });
      }
    }

    return { ok: true };
  });

  // ─── Internal: Baileys auth state storage ────────────────────────────────
  // GET /internal/wa-auth/:agentId → возвращает blob { creds, keys } из БД.
  // PUT /internal/wa-auth/:agentId ← воркер пушит обновлённый blob.
  // Хранится в WaConnection.authState (Json). Защищено x-internal-token.
  app.get("/internal/wa-auth/:agentId", async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }
    const { agentId } = z.object({ agentId: z.string().min(1) }).parse(request.params);
    const conn = await prisma.waConnection.findUnique({ where: { agentId } });
    if (!conn || !conn.authState || (typeof conn.authState === "object" && Object.keys(conn.authState).length === 0)) {
      reply.code(404);
      return { ok: false };
    }
    reply.header("content-type", "application/json");
    // Возвращаем сырой JSON — воркер сам ревайвит через BufferJSON.reviver.
    return conn.authState;
  });

  // Список агентов, у которых есть активная WhatsApp-сессия в БД.
  // Воркер дёргает это при старте, чтобы автоматически пересоединить
  // все живые боты после рестарта/деплоя.
  app.get("/internal/wa-connections/active", async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }
    const connections = await prisma.waConnection.findMany({
      where: {
        status: "connected",
        // Должен быть хоть какой-то authState — без него Baileys всё равно
        // не сможет залогиниться.
        NOT: { authState: { equals: {} } }
      },
      select: { agentId: true, styleHistoryCapture: true }
    });
    // agents[] — новый формат (с флагом захвата истории), agentIds[] оставлен
    // для обратной совместимости со старой версией воркера при выкате.
    return {
      agents: connections.map((c) => ({
        agentId: c.agentId,
        styleHistoryCapture: c.styleHistoryCapture
      })),
      agentIds: connections.map((c) => c.agentId)
    };
  });

  // ─── Internal: WA phone claim (анти-абуз) ───────────────────────────────
  // Worker зовёт этот эндпоинт в момент успешного pairing
  // (connection.update → "open"), когда уже знает реальный номер из
  // socket.user.id. Атомарно проверяем — не привязан ли этот номер уже к
  // ДРУГОМУ пользователю. Если да — отвечаем ALREADY_BOUND, worker должен
  // тут же разорвать сессию.
  //
  // Защита от race condition: UNIQUE(phoneHash) делает INSERT атомарным.
  // При конфликте проверяем владельца — тот же userId? обновляем
  // lastBoundAt и говорим ok (юзер переподключил свой же номер).
  app.post("/internal/wa-claim", async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }

    const body = z.object({
      agentId: z.string().min(1),
      phone: z.string().min(1)
    }).parse(request.body);

    const normalized = normalizeKzRuPhone(body.phone);
    if (!normalized) {
      reply.code(400);
      return { ok: false, reason: "INVALID_PHONE" as const };
    }

    const agent = await prisma.agent.findUnique({
      where: { id: body.agentId },
      select: { id: true, userId: true }
    });
    if (!agent) {
      reply.code(404);
      return { ok: false, reason: "AGENT_NOT_FOUND" as const };
    }
    if (!agent.userId) {
      // Анонимные агенты (без юзера) не могут «застолбить» номер — это
      // нарушило бы саму семантику «один номер на один аккаунт».
      reply.code(409);
      return { ok: false, reason: "AGENT_HAS_NO_OWNER" as const };
    }

    const phoneHash = hashWaPhone(normalized);

    const existing = await prisma.waPhoneClaim.findUnique({
      where: { phoneHash },
      select: { userId: true, agentId: true }
    });

    if (existing) {
      if (existing.userId !== agent.userId) {
        request.log.warn(
          { agentId: agent.id, userId: agent.userId, claimedBy: existing.userId },
          "wa-claim: phone already bound to different user — rejecting pair"
        );
        return {
          ok: false,
          reason: "ALREADY_BOUND" as const,
          message:
            "Этот номер WhatsApp уже привязан к другому аккаунту Jazu. " +
            "Один номер можно использовать только в одном аккаунте. " +
            "Если это ваш номер и нужно перенести, напишите в поддержку."
        };
      }

      // Тот же владелец — это reconnect/перепривязка к другому агенту того
      // же юзера. Обновляем метаданные.
      await prisma.waPhoneClaim.update({
        where: { phoneHash },
        data: {
          agentId: agent.id,
          lastBoundAt: new Date()
        }
      });
      return { ok: true, alreadyClaimed: true };
    }

    try {
      await prisma.waPhoneClaim.create({
        data: {
          phoneHash,
          userId: agent.userId,
          agentId: agent.id
        }
      });
    } catch (err) {
      // Race condition: между нашими findUnique и create другой запрос
      // успел вставить. Повторно читаем и решаем как выше.
      const raced = await prisma.waPhoneClaim.findUnique({
        where: { phoneHash },
        select: { userId: true }
      });
      if (raced && raced.userId !== agent.userId) {
        request.log.warn({ err }, "wa-claim: lost race with different user");
        return {
          ok: false,
          reason: "ALREADY_BOUND" as const,
          message:
            "Этот номер WhatsApp уже привязан к другому аккаунту Jazu. " +
            "Один номер можно использовать только в одном аккаунте. " +
            "Если это ваш номер и нужно перенести, напишите в поддержку."
        };
      }
      // Тот же владелец выиграл гонку — это ок, возвращаем успех.
      return { ok: true, alreadyClaimed: true };
    }

    await recordAudit({
      event: "wa.phone_claimed",
      userId: agent.userId,
      request,
      metadata: { agentId: agent.id, phoneHashPrefix: phoneHash.slice(0, 8) }
    });

    return { ok: true, alreadyClaimed: false };
  });

  // ─── Internal: pre-connection чаты (снимок из history-sync) ──────────────
  // Worker шлёт сюда chatId, существовавшие в WhatsApp ДО подключения.
  // Добавляем их в WaPreConnectionChat ТОЛЬКО в «окне свежей привязки»:
  // botRespondsSince установлен недавно. Это защищает от ситуации, когда
  // worker рестартит через дни, WhatsApp повторно шлёт history-sync со
  // ВСЕМИ чатами (включая те, что бот уже ведёт) — мы их не должны метить.
  const PRECONNECTION_WINDOW_MS = 15 * 60 * 1000; // 15 минут после привязки
  app.post("/internal/wa-preconnection-chats", {
    // FULL history-sync может содержать сотни-тысячи чатов — поднимаем лимит.
    bodyLimit: 8 * 1024 * 1024
  }, async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }

    const body = z.object({
      agentId: z.string().min(1),
      chatIds: z.array(z.string().min(1)).max(20000)
    }).parse(request.body);

    const conn = await prisma.waConnection.findUnique({
      where: { agentId: body.agentId },
      select: { botRespondsSince: true }
    });
    const respondsSince = conn?.botRespondsSince ?? null;
    // Окно закрыто (или привязки нет) — игнорируем history-sync. Это reconnect
    // старой сессии, чаты бота метить нельзя.
    if (!respondsSince || Date.now() - respondsSince.getTime() > PRECONNECTION_WINDOW_MS) {
      return { ok: true, skipped: true as const };
    }

    if (body.chatIds.length === 0) {
      return { ok: true, added: 0 };
    }

    const result = await prisma.waPreConnectionChat.createMany({
      data: body.chatIds.map((waChatId) => ({ agentId: body.agentId, waChatId })),
      skipDuplicates: true
    });

    return { ok: true, added: result.count };
  });

  // Фича «бот в стиле владельца», продуктовый источник: воркер шлёт сюда текст
  // личных диалогов из history-sync (только при WA_STYLE_HISTORY_CAPTURE). Буферим
  // в WaHistoryChat пачками — владелец потом выберет чаты в UI (/agent/style-history-*).
  app.post("/internal/wa-history-dialogues", {
    bodyLimit: 16 * 1024 * 1024
  }, async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }
    const body = z.object({
      agentId: z.string().min(1),
      dialogues: z
        .array(
          z.object({
            waChatId: z.string().min(1),
            label: z.string().max(300).optional(),
            messages: z
              .array(z.object({ fromMe: z.boolean(), text: z.string(), ts: z.number().optional() }))
              .max(5000)
          })
        )
        .max(200)
    }).parse(request.body);

    // history-sync приходит чанками: множества сообщений в разных событиях не
    // пересекаются, поэтому НЕ перезаписываем, а МЕРДЖИМ с уже сохранёнными
    // (append + dedupe по text+ts). Иначе последний чанк затирал бы предыдущие.
    const MAX_MESSAGES = 5000;
    let saved = 0;
    for (const d of body.dialogues) {
      if (d.messages.length === 0) continue;
      const existing = await prisma.waHistoryChat.findUnique({
        where: { agentId_waChatId: { agentId: body.agentId, waChatId: d.waChatId } },
        select: { messages: true }
      });
      const prev = (existing?.messages as HistoryMessage[] | null) ?? [];
      const seen = new Set(prev.map((m) => `${m.ts ?? ""}|${m.fromMe ? 1 : 0}|${m.text}`));
      const merged: HistoryMessage[] = [...prev];
      for (const m of d.messages) {
        const key = `${m.ts ?? ""}|${m.fromMe ? 1 : 0}|${m.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ fromMe: m.fromMe, text: m.text, ...(m.ts !== undefined ? { ts: m.ts } : {}) });
      }
      // Сортируем по времени и держим последние MAX_MESSAGES (свежее полезнее).
      merged.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      const capped = merged.length > MAX_MESSAGES ? merged.slice(-MAX_MESSAGES) : merged;
      await prisma.waHistoryChat.upsert({
        where: { agentId_waChatId: { agentId: body.agentId, waChatId: d.waChatId } },
        // label обновляем только если чанк его прислал — иначе сохраняем прежний.
        update: { messageCount: capped.length, messages: capped, ...(d.label ? { label: d.label } : {}) },
        create: {
          agentId: body.agentId,
          waChatId: d.waChatId,
          label: d.label ?? "",
          messageCount: capped.length,
          messages: capped
        }
      });
      saved += 1;
    }
    return { ok: true, saved };
  });

  // Прогресс history-sync от воркера (для статус-бара «подтягиваю историю»).
  // status: syncing (идёт, progress 0..100) | done (закончили → syncedAt=now).
  app.post("/internal/wa-history-progress", async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }
    const body = z
      .object({
        agentId: z.string().min(1),
        progress: z.number().nullable().optional(),
        status: z.enum(["syncing", "done"])
      })
      .parse(request.body);
    const done = body.status === "done";
    const clamped =
      typeof body.progress === "number"
        ? Math.max(0, Math.min(100, Math.round(body.progress)))
        : undefined;
    await prisma.waConnection.updateMany({
      where: { agentId: body.agentId },
      data: {
        styleHistoryStatus: done ? "done" : "syncing",
        ...(done ? { styleHistoryProgress: 100, styleHistorySyncedAt: new Date() } : {}),
        ...(!done && clamped !== undefined ? { styleHistoryProgress: clamped } : {})
      }
    });
    return { ok: true };
  });

  app.put("/internal/wa-auth/:agentId", {
    // authState Baileys раздувается после history-sync (сотни prekeys +
    // app-state мутации + signal sessions на каждый контакт) — легко
    // превышает глобальный bodyLimit (256 KB). Это internal-роут, защищён
    // x-internal-token и ходит только из wa-worker по внутренней сети,
    // поэтому поднимаем лимит индивидуально. Без этого PUT падает с
    // "Request body is too large", authState не сохраняется и сессия
    // не стабилизируется (бесконечный "failed to commit mutations").
    bodyLimit: 32 * 1024 * 1024
  }, async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }
    const { agentId } = z.object({ agentId: z.string().min(1) }).parse(request.params);
    const body = request.body;
    if (!body || typeof body !== "object") {
      reply.code(400);
      return { ok: false, error: "Invalid body" };
    }
    await prisma.waConnection.upsert({
      where: { agentId },
      update: {
        authState: body,
        authStateUpdatedAt: new Date()
      },
      create: {
        agentId,
        status: "disconnected",
        authState: body,
        authStateUpdatedAt: new Date()
      }
    });
    return { ok: true };
  });

  // Legacy/fallback HTTP path для обработки входящих WhatsApp-сообщений.
  // В production воркер кладёт задачу напрямую в Redis (wa:inbound), и этот
  // endpoint не используется. Оставляем для:
  //   - внешних вебхуков (когда подключим официальный WhatsApp Business API);
  //   - локальной отладки без Redis (когда переменная NO_QUEUE=1).
  // Сам обработчик идентичен тому, что запускает jobs-worker, чтобы не было
  // расхождения в поведении между путями.
  app.post("/whatsapp/inbound", async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }

    const payload = whatsappInboundSchema.parse(request.body);
    const sentWorkerSession = request.headers["x-worker-session"];
    const workerSessionId =
      typeof sentWorkerSession === "string" && sentWorkerSession.length > 0
        ? sentWorkerSession
        : undefined;

    const result = await processWaInbound(
      {
        agentId: payload.agentId,
        chatId: payload.chatId,
        ...(payload.senderName !== undefined ? { senderName: payload.senderName } : {}),
        ...(payload.senderPhone !== undefined ? { senderPhone: payload.senderPhone } : {}),
        message: payload.message,
        ...(payload.waMessageId !== undefined ? { waMessageId: payload.waMessageId } : {}),
        ...(workerSessionId ? { workerSessionId } : {}),
        ...(payload.messageTimestamp !== undefined ? { messageTimestamp: payload.messageTimestamp } : {})
      },
      {
        telegramBotToken: env.TELEGRAM_BOT_TOKEN,
        workerUrl: env.WA_WORKER_URL,
        internalToken: env.API_INTERNAL_TOKEN
      }
    );

    if (result.status === "agent_not_found") {
      reply.code(404);
      return { ok: false, error: "Agent not found" };
    }
    if (result.status === "worker_session_mismatch") {
      reply.code(409);
      return { ok: false, error: "Worker session mismatch" };
    }
    if (result.status === "deduplicated") {
      return { ok: true, reply: null, summary: null, leadId: null, deduplicated: true };
    }
    if (result.status === "quota_exhausted") {
      return {
        ok: true,
        reply: null,
        summary: "Квота диалогов исчерпана, бот не отвечает.",
        leadId: null,
        blocked: "quota_exhausted" as const,
        usage: result.usage
      };
    }
    if (result.status === "bot_loop_protected") {
      return {
        ok: true,
        reply: null,
        summary: null,
        leadId: null,
        blocked: "bot_loop" as const,
        outboundLastHour: result.outboundLastHour
      };
    }
    if (result.status === "bot_paused") {
      return {
        ok: true,
        reply: null,
        summary: null,
        leadId: null,
        blocked: "bot_paused" as const
      };
    }
    if (result.status === "pre_connection_message") {
      return {
        ok: true,
        reply: null,
        summary: null,
        leadId: null,
        blocked: "pre_connection" as const
      };
    }

    return {
      ok: true,
      reply: result.reply,
      summary: result.summary,
      leadId: result.leadId
    };
  });

  // Новый production-path для воркера: вместо синхронного inbound он может
  // положить задачу в очередь и сразу освободить Baileys event loop.
  // Возвращает jobId; ответ улетит обратно через wa:outbound.
  app.post("/whatsapp/inbound/enqueue", async (request, reply) => {
    if (!verifyInternalToken(request.headers["x-internal-token"], env.API_INTERNAL_TOKEN, env.API_INTERNAL_TOKEN_OLD)) {
      reply.code(401);
      return { ok: false, error: "Unauthorized" };
    }

    const payload = whatsappInboundSchema.parse(request.body);
    const sentWorkerSession = request.headers["x-worker-session"];
    const workerSessionId =
      typeof sentWorkerSession === "string" && sentWorkerSession.length > 0
        ? sentWorkerSession
        : undefined;

    try {
      const queue = getInboundQueue();
      const job = await queue.add(
        "wa-inbound",
        {
          agentId: payload.agentId,
          chatId: payload.chatId,
          ...(payload.senderName !== undefined ? { senderName: payload.senderName } : {}),
          ...(payload.senderPhone !== undefined ? { senderPhone: payload.senderPhone } : {}),
          message: payload.message,
          ...(payload.waMessageId !== undefined ? { waMessageId: payload.waMessageId } : {}),
          ...(workerSessionId ? { workerSessionId } : {}),
          requestId: request.id
        },
        {
          // jobId == waMessageId, если он есть, даёт BullMQ-уровень dedupe:
          // повторная попытка с тем же waMessageId не создаст новую задачу,
          // даже если БД ещё не успела увидеть сохранённое сообщение.
          ...(payload.waMessageId ? { jobId: `wa:${payload.agentId}:${payload.waMessageId}` } : {})
        }
      );
      return { ok: true, jobId: job.id };
    } catch (err) {
      request.log.error({ err }, "Failed to enqueue WA inbound");
      reply.code(503);
      return { ok: false, error: "Queue is unavailable" };
    }
  });

  app.post("/whatsapp/send", async (request, reply) => {
    const { agent } = await buildWriteSessionView(request, reply);
    const { chatId, text } = whatsappSendBodySchema.parse(request.body);
    await sendWorkerMessage(agent.id, { chatId, text });

    // Записываем исходящее в историю переписки. waMsgId оставляем null —
    // воркер не возвращает id, выданный WhatsApp'ом, для ручных отправок
    // через UI это и не нужно.
    const conversation = await getOrCreateConversation(agent.id, chatId);
    await prisma.waMessage.create({
      data: {
        conversationId: conversation.id,
        direction: "out",
        body: text,
        waMsgId: null,
        parts: jsonInput([{ type: "text", text }])
      }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() }
    });

    return { ok: true };
  });

  app.get("/chats", async (request, reply) => {
    const { agent } = await buildSessionView(request, reply);
    if (!agent) {
      return [];
    }
    const conversations = await prisma.conversation.findMany({
      where: {
        agentId: agent.id,
        // Тестовая conversation создаётся при handoff из /test-chat/chat —
        // её не показываем в общем списке, это не настоящий клиент.
        waChatId: { not: TEST_CONVERSATION_CHAT_ID }
      },
      orderBy: { lastMessageAt: "desc" },
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1
        },
        leads: {
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });

    return conversations.map((conversation) => ({
      ...conversation,
      lastMessage: conversation.messages[0] ?? null,
      lead: conversation.leads[0] ?? null
    }));
  });

  app.get("/chats/:id/messages", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { agent } = await buildSessionView(request, reply);
    if (!agent) {
      reply.code(401);
      return { ok: false, error: "Not authenticated" };
    }

    // IDOR protection: verify conversation belongs to current agent
    // и не относится к скрытой тестовой conversation.
    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        agentId: agent.id,
        waChatId: { not: TEST_CONVERSATION_CHAT_ID }
      }
    });
    if (!conversation) {
      reply.code(404);
      return { ok: false, error: "Conversation not found" };
    }

    const messages = await prisma.waMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" }
    });
    return messages.map((message) => ({
      id: message.id,
      role: message.direction === "out" ? "assistant" : "user",
      content: message.body,
      parts: message.parts,
      createdAt: message.createdAt.toISOString()
    }));
  });

  app.get("/leads", async (request, reply) => {
    const { agent } = await buildSessionView(request, reply);
    if (!agent) {
      return [];
    }
    const leads = await prisma.lead.findMany({
      where: {
        conversation: {
          agentId: agent.id,
          // Не показываем лиды, сгенерированные из /test-chat/chat:
          // это handoff из тестового диалога, а не настоящий клиент.
          waChatId: { not: TEST_CONVERSATION_CHAT_ID }
        }
      },
      orderBy: { createdAt: "desc" },
      include: {
        conversation: true
      }
    });
    return leads;
  });

  app.patch("/leads/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = leadPatchSchema.parse(request.body ?? {});
    const { agent } = await buildSessionView(request, reply);
    if (!agent) {
      reply.code(401);
      return { ok: false, error: "Not authenticated" };
    }

    // IDOR protection: verify lead belongs to current agent's conversation
    // и не относится к скрытой тестовой conversation.
    const lead = await prisma.lead.findFirst({
      where: {
        id,
        conversation: {
          agentId: agent.id,
          waChatId: { not: TEST_CONVERSATION_CHAT_ID }
        }
      }
    });
    if (!lead) {
      reply.code(404);
      return { ok: false, error: "Lead not found" };
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {})
      }
    });
    return updated;
  });

  app.get("/settings", async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { success: false, user: null, agent: null };
    }

    const agent = await prisma.agent.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: {
        waConnections: { orderBy: { createdAt: "desc" }, take: 1 },
        promptVersions: { orderBy: { createdAt: "desc" }, take: 1 }
      }
    });

    return { success: true, user, agent };
  });

  app.patch("/settings", async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { success: false, message: "Authentication required" };
    }

    const body = settingsBodySchema.parse(request.body ?? {});
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        // ВАЖНО: обновляем telegramChatId только если поле явно передано.
        // Иначе частые PATCH'и тура (только onboardingState) затирали бы
        // telegramChatId в null и пользователь терял бы уведомления.
        ...(body.telegramChatId !== undefined ? { telegramChatId: body.telegramChatId || null } : {}),
        ...(body.displayName !== undefined ? { name: body.displayName } : {}),
        ...(body.onboardingState !== undefined ? { onboardingState: jsonInput(body.onboardingState) } : {})
      }
    });

    const agent = await prisma.agent.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" }
    });

    return {
      success: true,
      user: updated,
      agent
    };
  });
};
