import { closeAllQueues, closeRedisWriter } from "@jazu/queue";
import {
  closeSentry,
  initPostHog,
  initSentry,
  installProcessErrorHandlers,
  shutdownPostHog
} from "@jazu/observability";
import { env } from "./env.js";
import { buildServer } from "./server.js";

initSentry({
  service: "api",
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  ...(env.RELEASE_VERSION ? { release: env.RELEASE_VERSION } : {})
});
initPostHog({ token: env.POSTHOG_PROJECT_TOKEN, host: env.POSTHOG_HOST });
installProcessErrorHandlers("api");

const server = await buildServer();

try {
  await server.listen({
    port: env.PORT,
    host: "0.0.0.0"
  });

  server.log.info(`API listening on ${env.PORT}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}

/**
 * Graceful shutdown. Fastify ждёт окончания всех текущих HTTP-запросов
 * (включая SSE-стримы). После этого закрываем Redis. Hard exit через 30с,
 * чтобы зависшие SSE не блокировали деплой навсегда.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    server.log.warn("second shutdown signal — force exit");
    process.exit(1);
  }
  shuttingDown = true;
  server.log.info({ signal }, "API shutting down");

  const hardExit = setTimeout(() => {
    server.log.error("graceful shutdown timed out — force exit");
    process.exit(1);
  }, 30_000);
  hardExit.unref();

  try {
    await server.close();
  } catch (err) {
    server.log.error({ err }, "error closing fastify");
  }
  try {
    await closeAllQueues();
    await closeRedisWriter();
  } catch (err) {
    server.log.error({ err }, "error closing redis/queues");
  }
  try {
    await closeSentry();
  } catch (err) {
    server.log.error({ err }, "error closing sentry");
  }
  try {
    await shutdownPostHog();
  } catch (err) {
    server.log.error({ err }, "error closing posthog");
  }

  clearTimeout(hardExit);
  server.log.info("API stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
