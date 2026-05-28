import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@jazu/db";
import { actionButtonSchema, businessProfileSchema, type ActionButton, type PromptCard } from "@jazu/shared";
import {
  applyPromptCorrection,
  buildBuilderTurn,
  buildFallbackPrompt,
  buildRuntimeTurn,
  createInitialProfile,
  mergeProfile,
  summarizeLead
} from "@jazu/ai";
import { env } from "./env.js";
import {
  getCurrentAgent,
  getOrCreateAgent,
  getOrCreateSession,
  getUserFromRequest,
  revokeSession,
  rotateAndLoginSession
} from "./lib/session.js";
import {
  generateMagicCode,
  hashMagicCode,
  MAGIC_CODE_TTL_MS,
  verifyInternalToken,
  verifyMagicLink
} from "./lib/auth.js";
import { normalizeKzRuPhone } from "./lib/phone.js";
import { hashWaPhone } from "./lib/phone-hash.js";
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
  buildLlmTelemetry,
  getDailyTokenUsage,
  getUsageView,
  processWaInbound,
  type PlanId
} from "@jazu/wa-pipeline";
import { getInboundQueue } from "@jazu/queue";
import { sendMagicCodeEmail, sendTelegramLead } from "./lib/notifications.js";
import { recordAudit } from "./lib/audit.js";

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

const chatBodySchema = z.object({
  message: z.string().min(1)
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
  message: z.string().min(1),
  waMessageId: z.string().optional()
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
  options: { changeKind?: "create" | "edit" | "correction"; changeSummary?: string } = {}
): PromptCard | undefined {
  if (!next) return undefined;
  if (!prev) {
    return {
      kind: "update",
      changeKind: options.changeKind ?? "create",
      prompt: next,
      addedLines: [],
      removedLines: [],
      charCount: next.length,
      editsCount: 0,
      ...(options.changeSummary ? { changeSummary: options.changeSummary } : {})
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
    ...(options.changeSummary ? { changeSummary: options.changeSummary } : {})
  };
}

function profileScore(profile: ReturnType<typeof businessProfileSchema.parse>): number {
  let score = 0;
  if (profile.businessName && profile.businessName.trim().length > 1) score += 2;
  if (profile.niche && profile.niche.trim().length > 1) score += 2;
  if (profile.description && profile.description.trim().length > 5) score += 1;
  if (profile.offerings && profile.offerings.length > 0) score += 2;
  if (profile.targetAudience) score += 1;
  if (profile.geography) score += 1;
  if (profile.hours) score += 1;
  if (profile.bookingFlow) score += 1;
  if (profile.handoffRules) score += 1;
  if (profile.tone) score += 1;
  return score;
}

function isProfileReadyForPrompt(profile: ReturnType<typeof businessProfileSchema.parse>): boolean {
  const hasName = Boolean(profile.businessName && profile.businessName.trim().length > 1);
  const hasNiche = Boolean(profile.niche && profile.niche.trim().length > 1);
  const hasOfferings = Array.isArray(profile.offerings) && profile.offerings.length > 0;
  const hasDescription = Boolean(profile.description && profile.description.trim().length > 5);
  if (!hasName || !hasNiche) return false;
  if (!hasOfferings && !hasDescription) return false;
  return profileScore(profile) >= 6;
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

async function savePromptVersion(agentId: string, content: string, source: "create" | "edit" | "correction") {
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

async function writeLeadIfNeeded(agentId: string, conversationId: string, summary: string, message: string, shouldCreate: boolean) {
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
        createdAt: new Date().toISOString()
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
      [`<b>Новый лид</b>`, summary, `Agent: ${agent.name}`].join("\n")
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
    // отправляем добивать номер.
    const target = user.phone ? "/dashboard" : "/auth/phone";
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

  // ─── Billing ────────────────────────────────────────────────────────────
  // Публичный список пакетов + цены — фронт читает один раз на /billing.
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

  // Stub-оплата: создаём Purchase, увеличиваем quotaTotal. Без реальной
  // платёжки. Когда подключим Kaspi/CloudPayments — добавим pending → paid.
  const purchaseBodySchema = z.object({
    packageId: z.enum(["basic", "pro", "max", "custom"]),
    customCount: z.number().int().min(CUSTOM_MIN).max(CUSTOM_MAX).optional()
  });
  app.post("/billing/purchase", async (request, reply) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      reply.code(401);
      return { ok: false, error: "Not authenticated" };
    }
    const body = purchaseBodySchema.parse(request.body);

    let conversations: number;
    if (body.packageId === "custom") {
      if (!body.customCount) {
        reply.code(400);
        return { ok: false, error: "customCount обязателен для пакета custom" };
      }
      // Округляем до шага.
      conversations = Math.round(body.customCount / CUSTOM_STEP) * CUSTOM_STEP;
      conversations = Math.max(CUSTOM_MIN, Math.min(CUSTOM_MAX, conversations));
    } else {
      const plan = PLANS.find((p) => p.id === (body.packageId as PlanId));
      if (!plan || plan.conversations === null) {
        reply.code(400);
        return { ok: false, error: "Unknown package" };
      }
      conversations = plan.conversations;
    }

    const amount = conversations * PRICE_PER_DIALOG_KZT;

    const purchase = await prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          userId: user.id,
          packageId: body.packageId,
          conversations,
          pricePerOne: PRICE_PER_DIALOG_KZT,
          amount,
          currency: "KZT",
          status: "paid"
        }
      });
      await tx.user.update({
        where: { id: user.id },
        data: { quotaTotal: { increment: conversations } }
      });
      return created;
    });

    await recordAudit({
      event: "purchase.completed",
      userId: user.id,
      request,
      metadata: {
        purchaseId: purchase.id,
        packageId: body.packageId,
        conversations,
        amount,
        currency: "KZT"
      }
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

    // Phone обязателен. Если у юзера его ещё нет — отправляем добивать.
    const target = user.phone ? "/dashboard" : "/auth/phone";
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
    const { message } = chatBodySchema.parse(request.body);
    const { session, agent } = await buildWriteSessionView(request, reply);
    const profile = await ensureAgentProfile(agent.id);

    await prisma.builderMessage.create({
      data: {
        agentId: agent.id,
        role: "user",
        content: message,
        parts: jsonInput([{ type: "text", text: message }])
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

    const promptCard = buildPromptCard(currentPrompt, result.newPrompt, {
      changeKind: "correction",
      changeSummary: result.changeSummary
    });
    await savePromptVersion(agent.id, result.newPrompt, "correction");

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
        testBotHistory: []
      }
    });
    return { ok: true };
  });

  app.post("/test-chat/correct", async (request, reply) => {
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

    const promptCard = buildPromptCard(currentPrompt, result.newPrompt, {
      changeKind: "correction",
      changeSummary: result.changeSummary
    });
    await savePromptVersion(agent.id, result.newPrompt, "correction");

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
        orderBy: { createdAt: "asc" },
        take: 16
      });
      try {
        const turn = await buildRuntimeTurn(
          profile,
          userMessage,
          history.map((item) => ({
            role: item.role === "assistant" ? "assistant" : "user",
            content: item.content
          })),
          {
            systemOverride: result.newPrompt,
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
      promptCard,
      staleMessageId: targetMessage?.id ?? null,
      regenerated
    };
  });

  app.post("/test-chat/chat", async (request, reply) => {
    const { message } = chatBodySchema.parse(request.body);
    const { agent } = await buildWriteSessionView(request, reply);
    const profile = await ensureAgentProfile(agent.id);

    await prisma.testMessage.create({
      data: {
        agentId: agent.id,
        role: "user",
        content: message,
        parts: jsonInput([{ type: "text", text: message }])
      }
    });

    const history = await prisma.testMessage.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: "asc" },
      take: 16
    });

    const stream = startSseStream(request, reply);

    try {
      const turn = await buildRuntimeTurn(
        profile,
        message,
        history.map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: item.content
        })),
        {
          systemOverride: agent.currentPrompt,
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

      if (turn.shouldHandoff) {
        // chatId фиксирован, чтобы все handoff из теста сливались в одну
        // и ту же conversation, а не плодили мусор. Эта conversation
        // отфильтровывается в /chats и /leads (см. TEST_CONVERSATION_CHAT_ID).
        const conversation = await getOrCreateConversation(
          agent.id,
          TEST_CONVERSATION_CHAT_ID,
          "Test client"
        );
        await writeLeadIfNeeded(agent.id, conversation.id, turn.summary || summarizeLead(profile, message), message, true);
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
    const workerStatus = await startWorkerConnection(agent.id);

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
        authStateUpdatedAt: new Date()
      },
      create: {
        agentId: agent.id,
        status: "disconnected",
        authState: {},
        qrText: null,
        workerSessionId: null
      }
    });

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
      workerSessionId: z.string().nullable().optional()
    }).parse(request.body);

    await prisma.waConnection.upsert({
      where: { agentId: body.agentId },
      update: {
        status: body.status,
        qrText: body.qrText ?? null,
        qrDataUrl: body.qrDataUrl ?? null,
        workerSessionId: body.workerSessionId ?? null,
        phone: body.phone ?? null,
        lastSeenAt: new Date()
      },
      create: {
        agentId: body.agentId,
        status: body.status,
        authState: {},
        qrText: body.qrText ?? null,
        qrDataUrl: body.qrDataUrl ?? null,
        workerSessionId: body.workerSessionId ?? null,
        phone: body.phone ?? null,
        lastSeenAt: new Date()
      }
    });

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
      select: { agentId: true }
    });
    return { agentIds: connections.map((c) => c.agentId) };
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
            "Если это ваш номер и нужно перенести — напишите в поддержку."
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
            "Если это ваш номер и нужно перенести — напишите в поддержку."
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

  app.put("/internal/wa-auth/:agentId", async (request, reply) => {
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
        message: payload.message,
        ...(payload.waMessageId !== undefined ? { waMessageId: payload.waMessageId } : {}),
        ...(workerSessionId ? { workerSessionId } : {})
      },
      { telegramBotToken: env.TELEGRAM_BOT_TOKEN }
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
        summary: "Квота диалогов исчерпана — бот не отвечает.",
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
        telegramChatId: body.telegramChatId ?? null,
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
