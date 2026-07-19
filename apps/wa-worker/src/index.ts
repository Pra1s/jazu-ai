import Fastify from "fastify";
import { z } from "zod";
import { env } from "./env.js";
import { ConnectionManager } from "./manager.js";
import { startOutboundWorker } from "./outbound-worker.js";
import {
  closeAllQueues,
  closeRedisWriter,
  getRedisWriter,
  type StartedWorker,
  type WaOutboundJob
} from "@jazu/queue";
import {
  captureError,
  closeSentry,
  extractOrGenerateRequestId,
  initSentry,
  installProcessErrorHandlers,
  REQUEST_ID_HEADER,
  runReadiness
} from "@jazu/observability";

initSentry({
  service: "wa-worker",
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  ...(env.RELEASE_VERSION ? { release: env.RELEASE_VERSION } : {})
});
installProcessErrorHandlers("wa-worker");

const manager = new ConnectionManager();
const app = Fastify({
  logger: {
    level: env.NODE_ENV === "development" ? "info" : "warn"
  },
  // E2E-трассировка: переиспользуем X-Request-Id от API (если есть),
  // иначе генерируем UUID. Тот же id вернётся в ответе и попадёт в Sentry.
  genReqId: (req) => extractOrGenerateRequestId(req.headers),
  requestIdHeader: REQUEST_ID_HEADER,
  requestIdLogLabel: "reqId"
});

app.addHook("onSend", async (request, reply) => {
  reply.header(REQUEST_ID_HEADER, request.id);
});

let outboundWorker: StartedWorker<WaOutboundJob> | undefined;

// Публичные endpoint'ы — healthcheck'и k8s/Compose обходятся без internal-token.
const PUBLIC_PATHS = new Set(["/health", "/healthz", "/readyz"]);

// Глобальный обработчик ошибок: любую необработанную исключительную ситуацию
// (включая ZodError из body-валидатора) логируем и отправляем в Sentry,
// чтобы видеть проблемы wa-worker'а наравне с API.
app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error, reqId: request.id }, "wa-worker request failed");
  captureError(error, {
    requestId: request.id,
    route: `${request.method} ${request.routeOptions?.url ?? request.url}`,
    extra: { ip: request.ip }
  });
  if (reply.sent) return;
  reply.code(500).send({
    statusCode: 500,
    error: "Internal Server Error",
    message: error instanceof Error ? error.message : "Unknown error",
    requestId: request.id
  });
});

app.addHook("onRequest", async (request, reply) => {
  if (PUBLIC_PATHS.has(request.url)) {
    return;
  }

  const provided = request.headers["x-internal-token"];
  if (typeof provided !== "string") {
    return reply.code(401).send({ ok: false, error: "Unauthorized" });
  }
  const accepted = [env.API_INTERNAL_TOKEN];
  if (env.API_INTERNAL_TOKEN_OLD) accepted.push(env.API_INTERNAL_TOKEN_OLD);
  if (!accepted.includes(provided)) {
    return reply.code(401).send({ ok: false, error: "Unauthorized" });
  }
});

app.get("/health", async () => ({
  ok: true,
  name: "jazu-wa-worker",
  timestamp: new Date().toISOString()
}));

app.get("/healthz", async () => ({ ok: true, service: "wa-worker", at: new Date().toISOString() }));

app.get("/readyz", async (_request, reply) => {
  const report = await runReadiness("wa-worker", [
    ...(env.REDIS_URL
      ? [
          {
            name: "redis",
            check: async () => {
              const pong = await getRedisWriter().ping();
              if (pong !== "PONG") throw new Error(`unexpected redis reply: ${String(pong)}`);
            }
          }
        ]
      : []),
    {
      name: "api",
      check: async () => {
        // API недоступен — не критично (мы консумим только Redis-задачи),
        // поэтому ставим короткий таймаут. Это soft-check для k8s readiness.
        // ВАЖНО: /healthz зарегистрирован НЕ под префиксом /api (это глобальный
        // liveness endpoint Fastify). Без auth, тащить токен не надо.
        const res = await fetch(new URL("/healthz", env.API_ORIGIN));
        if (!res.ok) throw new Error(`api healthz HTTP ${res.status}`);
      },
      timeoutMs: 1_500
    }
  ]);
  if (!report.ok) reply.code(503);
  return report;
});

app.post("/connections/:agentId/start", async (request) => {
  const { agentId } = z.object({ agentId: z.string().min(1) }).parse(request.params);
  // styleHistoryCapture (опц.) — согласие владельца на захват личной истории для
  // фичи «бот в стиле владельца». Прокидываем в менеджер (он держит флаг per-agent).
  const body = z
    .object({ styleHistoryCapture: z.boolean().optional() })
    .parse(request.body ?? {});
  return manager.start(
    agentId,
    body.styleHistoryCapture !== undefined ? { styleHistoryCapture: body.styleHistoryCapture } : {}
  );
});

app.post("/connections/:agentId/pair", async (request, reply) => {
  const { agentId } = z.object({ agentId: z.string().min(1) }).parse(request.params);
  const { phone, styleHistoryCapture } = z
    .object({
      phone: z.string().regex(/^\d{10,15}$/),
      styleHistoryCapture: z.boolean().optional()
    })
    .parse(request.body);
  try {
    return await manager.pair(
      agentId,
      phone,
      styleHistoryCapture !== undefined ? { styleHistoryCapture } : {}
    );
  } catch (err) {
    captureError(err, { agentId, route: "wa-worker:pair" });
    const message = err instanceof Error ? err.message : "Не удалось получить код";
    reply.code(409);
    return { ok: false, error: message };
  }
});

app.get("/connections/:agentId/status", async (request) => {
  const { agentId } = z.object({ agentId: z.string().min(1) }).parse(request.params);
  return manager.status(agentId);
});

app.delete("/connections/:agentId", async (request) => {
  const { agentId } = z.object({ agentId: z.string().min(1) }).parse(request.params);
  return manager.stop(agentId);
});

app.post("/connections/:agentId/send", async (request) => {
  const { agentId } = z.object({ agentId: z.string().min(1) }).parse(request.params);
  const body = z.object({
    chatId: z.string().min(1),
    text: z.string().min(1)
  }).parse(request.body);
  await manager.send(agentId, body);
  return { ok: true };
});

/**
 * При старте/рестарте worker'а поднимаем все ранее подключённые сессии
 * (status = "connected" в БД). Без этого после деплоя или OOM-kill все
 * боты молчат, пока юзер вручную не зайдёт на /whatsapp и не пересоединит.
 */
type ActiveAgent = { agentId: string; styleHistoryCapture?: boolean };

async function fetchActiveAgents(): Promise<ActiveAgent[] | null> {
  try {
    const response = await fetch(new URL("/api/internal/wa-connections/active", env.API_ORIGIN), {
      headers: { "x-internal-token": env.API_INTERNAL_TOKEN }
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { agents?: ActiveAgent[]; agentIds?: string[] };
    // Новый формат — agents[] с флагом захвата; agentIds[] оставлен для совместимости.
    if (Array.isArray(data.agents)) return data.agents;
    if (Array.isArray(data.agentIds)) return data.agentIds.map((agentId) => ({ agentId }));
    return [];
  } catch {
    return null;
  }
}

async function resumeActiveConnections() {
  if (!env.API_ORIGIN) return;

  // API может ещё не быть готов (порядок старта контейнеров). Делаем
  // retry с backoff: 1s, 2s, 4s, 8s, 15s, 30s, 60s — суммарно ~2 мин.
  const backoffMs = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
  let agents: ActiveAgent[] | null = null;
  for (let i = 0; i < backoffMs.length; i++) {
    agents = await fetchActiveAgents();
    if (agents !== null) break;
    const wait = backoffMs[i] ?? 60_000;
    app.log.info({ attempt: i + 1, retryInMs: wait }, "API not ready yet, will retry resume");
    await new Promise((r) => setTimeout(r, wait));
  }
  if (agents === null) {
    app.log.error("Could not reach API to resume WhatsApp connections after multiple retries");
    return;
  }

  app.log.info({ count: agents.length }, "Resuming WhatsApp connections after worker boot");
  // Стартуем последовательно с задержкой, чтобы не залить API и не словить
  // rate-limit от WA. Флаг захвата истории восстанавливаем из БД.
  for (const { agentId, styleHistoryCapture } of agents) {
    try {
      await manager.start(
        agentId,
        styleHistoryCapture !== undefined ? { styleHistoryCapture } : {}
      );
      app.log.info({ agentId }, "Resumed WhatsApp session");
    } catch (err) {
      app.log.error({ agentId, err: err instanceof Error ? err.message : err }, "Failed to resume");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

try {
  await app.listen({
    port: env.PORT,
    host: "0.0.0.0"
  });
  app.log.info(`WA worker listening on ${env.PORT}`);

  if (env.REDIS_URL) {
    outboundWorker = startOutboundWorker(manager);
    app.log.info({ concurrency: env.WA_OUTBOUND_CONCURRENCY }, "wa:outbound consumer started");
  } else {
    app.log.warn(
      "REDIS_URL is not set — falling back to legacy sync HTTP inbound. Production needs Redis."
    );
  }

  // Запускаем восстановление в фоне — не блокируем boot.
  void resumeActiveConnections();
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

/**
 * Graceful shutdown для wa-worker.
 *
 * Что делаем при SIGTERM/SIGINT:
 *   1. Перестаём принимать новые HTTP-запросы (Fastify close).
 *   2. Останавливаем BullMQ outbound consumer — дожидаемся текущих send().
 *   3. Закрываем все активные Baileys-сокеты (manager.stop для каждого).
 *      Это важно, чтобы partial creds НЕ записались в БД во время kill.
 *   4. Закрываем Redis-конекшены.
 *
 * При повторном сигнале или таймауте 30s — выходим жёстко с кодом 1.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    app.log.warn("second shutdown signal — force exit");
    process.exit(1);
  }
  shuttingDown = true;
  app.log.info({ signal }, "wa-worker shutting down");

  const hardExit = setTimeout(() => {
    app.log.error("graceful shutdown timed out — force exit");
    process.exit(1);
  }, 30_000);
  hardExit.unref();

  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, "error closing fastify");
  }
  try {
    if (outboundWorker) {
      await outboundWorker.close();
    }
  } catch (err) {
    app.log.error({ err }, "error closing outbound worker");
  }
  try {
    await manager.shutdown();
  } catch (err) {
    app.log.error({ err }, "error closing baileys sockets");
  }
  try {
    await closeAllQueues();
    await closeRedisWriter();
  } catch (err) {
    app.log.error({ err }, "error closing redis/queues");
  }
  try {
    await closeSentry();
  } catch (err) {
    app.log.error({ err }, "error closing sentry");
  }

  clearTimeout(hardExit);
  app.log.info("wa-worker stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
