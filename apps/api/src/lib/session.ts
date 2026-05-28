import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@jazu/db";
import { buildSessionCookie, clearAuthCookieOptions } from "./auth.js";
import { createInitialProfile, buildFallbackPrompt } from "@jazu/ai";

export const SESSION_COOKIE = "jazu_session_id";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 дней
const SESSION_LAST_SEEN_THROTTLE_MS = 1000 * 60 * 5; // обновляем lastSeenAt не чаще раза в 5 минут

export type CurrentContext = {
  session: Awaited<ReturnType<typeof getOrCreateSession>>;
  user: Awaited<ReturnType<typeof getUserFromRequest>>;
  agentId: string;
};

function isSessionActive(session: { expiresAt: Date | null; revokedAt: Date | null }): boolean {
  if (session.revokedAt) return false;
  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) return false;
  return true;
}

async function touchSession(sessionId: string, current: { lastSeenAt: Date | null }) {
  const now = Date.now();
  if (current.lastSeenAt && now - current.lastSeenAt.getTime() < SESSION_LAST_SEEN_THROTTLE_MS) {
    return;
  }
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date(now) }
  });
}

export async function getOrCreateSession(request: FastifyRequest, reply: FastifyReply) {
  const cookieId = request.cookies[SESSION_COOKIE];
  if (cookieId) {
    const existing = await prisma.session.findUnique({
      where: { cookieId },
      include: { agent: true, user: true }
    });
    if (existing && isSessionActive(existing)) {
      // Не блокируем горячий путь — лёгкий апдейт времени посещения,
      // дроссируется до раза в 5 минут.
      void touchSession(existing.id, existing).catch(() => undefined);
      return existing;
    }
    // Старая или revoked-сессия — создаём свежую запись, но с новым cookieId.
  }

  const newCookieId = randomUUID();
  const profile = createInitialProfile();
  const prompt = buildFallbackPrompt(profile);
  const now = new Date();

  const session = await prisma.session.create({
    data: {
      cookieId: newCookieId,
      promptDraft: prompt,
      readyToFinalize: false,
      isGenerating: false,
      createAgentHistory: [],
      promptBuilderHistory: [],
      testBotHistory: [],
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      lastSeenAt: now
    },
    include: {
      agent: true,
      user: true
    }
  });

  reply.setCookie(SESSION_COOKIE, newCookieId, buildSessionCookie(newCookieId).options);
  return session;
}

/**
 * Источник истины для текущего пользователя — Session.userId в БД.
 * Cookie jazu_user_id больше не используется (раньше юзер мог его подделать).
 */
export async function getUserFromRequest(request: FastifyRequest) {
  const cookieId = request.cookies[SESSION_COOKIE];
  if (!cookieId) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { cookieId },
    include: { user: true }
  });

  if (!session || !isSessionActive(session) || !session.user) {
    return null;
  }

  // GDPR: пользователь с deletedAt не должен считаться залогиненным даже
  // если каким-то чудом cookie выжил после deleteUserAccount() (DELETE
  // /auth/me чистит все sessions, но на всякий случай дублируем тут).
  if (session.user.deletedAt) {
    return null;
  }

  return session.user;
}

const agentInclude = {
  businessProfile: true,
  promptVersions: {
    orderBy: { createdAt: "desc" as const },
    take: 1
  }
};

/**
 * Returns the agent linked to the current session if one exists.
 * Does NOT create a new agent — use getOrCreateAgent() for that.
 */
export async function getCurrentAgent(request: FastifyRequest, reply: FastifyReply) {
  const session = await getOrCreateSession(request, reply);

  if (session.agentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: session.agentId },
      include: agentInclude
    });
    if (agent) {
      return agent;
    }
  }

  if (session.userId) {
    const agent = await prisma.agent.findFirst({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
      include: agentInclude
    });

    if (agent) {
      if (session.agentId !== agent.id) {
        await prisma.session.update({
          where: { id: session.id },
          data: { agentId: agent.id }
        });
      }
      return agent;
    }
  }

  return null;
}

/**
 * Like getCurrentAgent but lazily creates an agent if none exists yet.
 * Used only in write paths (agent/chat, test-chat).
 */
export async function getOrCreateAgent(request: FastifyRequest, reply: FastifyReply) {
  const existing = await getCurrentAgent(request, reply);
  if (existing) {
    return existing;
  }

  const session = await getOrCreateSession(request, reply);
  const seedProfile = createInitialProfile();
  const prompt = buildFallbackPrompt(seedProfile);

  const newAgent = await prisma.agent.create({
    data: {
      userId: session.userId ?? null,
      name: "AI-менеджер",
      status: "draft",
      currentPrompt: prompt,
      readyToFinalize: false,
      businessProfile: {
        create: { data: seedProfile }
      }
      // Первая PromptVersion создаётся только когда LLM сам решит
      // promptEvent="create" в /agent/chat.
    },
    include: agentInclude
  });

  await prisma.session.update({
    where: { id: session.id },
    data: { agentId: newAgent.id }
  });

  return newAgent;
}

export async function ensureLinkedAgent(request: FastifyRequest, reply: FastifyReply) {
  const session = await getOrCreateSession(request, reply);
  const agent = await getCurrentAgent(request, reply);
  return { session, agent };
}

/**
 * Атомарно «логинит» пользователя в текущую сессию, попутно ротируя cookieId
 * (защита от session fixation) и привязывая агента.
 */
export async function rotateAndLoginSession(
  reply: FastifyReply,
  sessionId: string,
  userId: string,
  agentId: string
) {
  const newCookieId = randomUUID();
  const now = new Date();
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      cookieId: newCookieId,
      userId,
      agentId,
      revokedAt: null,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      lastSeenAt: now
    }
  });
  reply.setCookie(SESSION_COOKIE, newCookieId, buildSessionCookie(newCookieId).options);
  return newCookieId;
}

/**
 * Помечает текущую сессию как revoked и выдаёт юзеру новую анонимную сессию.
 * Используется в /auth/logout. Полностью клиентский cookieId уезжает в null,
 * вернувшись только при следующем запросе через getOrCreateSession.
 */
export async function revokeSession(reply: FastifyReply, sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), userId: null, agentId: null }
  });
  reply.clearCookie(SESSION_COOKIE, clearAuthCookieOptions());
}
