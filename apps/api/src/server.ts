import Fastify, { type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { prisma } from "@jazu/db";
import {
  captureError,
  extractOrGenerateRequestId,
  REQUEST_ID_HEADER,
  runReadiness
} from "@jazu/observability";
import { getRedisWriter } from "@jazu/queue";
import { env } from "./env.js";
import { apiRoutes } from "./routes.js";

/**
 * Резолвим userId из cookie до того, как @fastify/rate-limit считает ключ.
 * Так per-user лимит работает даже у юзеров за общим NAT (один офис — один IP):
 * один юзер не может выжрать чужую квоту IP.
 *
 * Если cookie нет / сессия истекла — fallback на IP.
 */
async function resolveUserKey(request: FastifyRequest): Promise<string> {
  const cookieId = request.cookies["jazu_session_id"];
  if (cookieId) {
    const session = await prisma.session.findUnique({
      where: { cookieId },
      select: { userId: true, revokedAt: true }
    });
    if (session?.userId && !session.revokedAt) {
      return `u:${session.userId}`;
    }
  }
  return `ip:${request.ip}`;
}

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "info" : "warn"
    },
    trustProxy: true,
    bodyLimit: 256 * 1024, // 256 KB — отбиваем мегабайтные JSON-абузы
    // Request-id end-to-end: либо берём X-Request-Id от клиента/балансера,
    // либо генерим UUID. Используется в логах, SSE-ответе и в job data при
    // enqueue (apps/jobs логирует тем же reqId).
    genReqId: (req) => extractOrGenerateRequestId(req.headers as Record<string, unknown>),
    requestIdHeader: REQUEST_ID_HEADER,
    requestIdLogLabel: "reqId"
  });

  // На каждом ответе светим клиенту X-Request-Id — на фронте удобно
  // прокинуть в сообщение «у юзера не пришёл ответ» для трассировки.
  app.addHook("onSend", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: [env.WEB_ORIGIN],
    credentials: true
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(sensible);

  // Кэшируем userId на одну итерацию запроса, чтобы keyGenerator не делал
  // отдельный prisma.session.findUnique каждый раз.
  app.addHook("onRequest", async (request) => {
    (request as { __rateKey?: string }).__rateKey = await resolveUserKey(request);
  });

  // Глобальный per-user rate-limit. Сильно щедрее, чем per-route:
  // - 240 req/min на юзера (или IP, если не залогинен) — это потолок;
  // - чувствительные routes (auth, chat, billing) задают свои лимиты ниже
  //   через config.rateLimit на самом route'е.
  await app.register(rateLimit, {
    max: 240,
    timeWindow: "1 minute",
    keyGenerator: (request) => (request as { __rateKey?: string }).__rateKey ?? `ip:${request.ip}`,
    addHeadersOnExceeding: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Слишком часто. Подождите ${Math.ceil(ctx.ttl / 1000)}с.`
    })
  });

  // Liveness — процесс жив. Используется k8s/docker для рестарта при зависании.
  app.get("/healthz", async () => ({ ok: true, service: "api", at: new Date().toISOString() }));

  // Debug-only: смоук-тест Sentry. Выключен в production, чтобы юзеры не могли
  // спамить ошибками в наш Sentry-инстанс. В dev'е удобно проверить, что
  // capture доезжает до GlitchTip: `curl -X POST http://localhost:3001/__debug/throw`.
  if (env.NODE_ENV !== "production") {
    app.post("/__debug/throw", async () => {
      throw new Error(`Sentry smoke-test ${new Date().toISOString()}`);
    });
  }

  // Readiness — мы готовы принимать трафик. Включает прогон pingов до зависимостей.
  // Если БД/Redis отвалились — k8s перестаёт лить на нас запросы, но pod остаётся.
  app.get("/readyz", async (_request, reply) => {
    const report = await runReadiness("api", [
      {
        name: "postgres",
        check: async () => {
          await prisma.$queryRaw`SELECT 1`;
        }
      },
      {
        name: "redis",
        check: async () => {
          const redis = getRedisWriter();
          const pong = await redis.ping();
          if (pong !== "PONG") throw new Error(`unexpected redis reply: ${String(pong)}`);
        }
      }
    ]);
    if (!report.ok) reply.code(503);
    return report;
  });

  // ВАЖНО: setErrorHandler / setNotFoundHandler ставим ДО register'а
  // apiRoutes. В Fastify v5 эти handler'ы encapsulated по plugin-контексту;
  // если поставить ИХ после register'а — они применятся только к routes,
  // зарегистрированным после, и НЕ будут ловить ошибки внутри apiRoutes
  // (включая ZodError от валидации body). Это была реальная регрессия:
  // captureError не вызывался для 500 в /api/*.
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
      requestId: request.id
    });
  });

  app.setErrorHandler((error, request, reply) => {
    // Ошибки zod-валидации body — это некорректный ввод клиента, а не сбой
    // сервера: отдаём 400 с человекочитаемым сообщением (первая issue), а не 500.
    if (error instanceof ZodError) {
      request.log.warn({ err: error, reqId: request.id }, "request validation failed");
      if (!reply.sent) {
        reply.code(400).send({
          message: error.issues[0]?.message ?? "Некорректные данные запроса",
          error: "Bad Request",
          statusCode: 400,
          requestId: request.id
        });
      }
      return;
    }
    // Ошибки Fastify с клиентским статусом (413 body too large, 429 rate-limit,
    // 400 битый JSON и т.п.) — не сбои сервера: отдаём их статус, в Sentry не шлём.
    const rawStatus = (error as { statusCode?: unknown } | null)?.statusCode;
    const statusCode = typeof rawStatus === "number" ? rawStatus : 500;
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn({ err: error, reqId: request.id }, "request rejected");
      if (!reply.sent) {
        reply.code(statusCode).send({
          message: error instanceof Error ? error.message : "Request rejected",
          error: "Client Error",
          statusCode,
          requestId: request.id
        });
      }
      return;
    }

    request.log.error({ err: error, reqId: request.id }, "request failed");
    captureError(error, {
      requestId: request.id,
      route: `${request.method} ${request.routeOptions?.url ?? request.url}`,
      extra: { ip: request.ip }
    });
    if (reply.sent) {
      return;
    }

    reply.code(500).send({
      message: error instanceof Error ? error.message : "Unknown error",
      error: "Internal Server Error",
      requestId: request.id
    });
  });

  await app.register(apiRoutes, { prefix: "/api" });

  return app;
}
