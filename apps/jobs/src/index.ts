import Fastify from "fastify";
import { prisma } from "@jazu/db";
import {
  closeAllQueues,
  closeRedisWriter,
  getRedisWriter,
  QUEUE_WA_INBOUND,
  QUEUE_WA_FLUSH,
  QUEUE_LEAD_NOTIFY,
  QUEUE_STYLE_ANALYZE,
  QUEUE_WA_FOLLOWUP,
  QUEUE_WA_DELIVERY,
  startWorker,
  type WaInboundJob,
  type WaFlushJob,
  type LeadNotifyJob,
  type StyleAnalyzeJob,
  type FollowupJob,
  type WaDeliveryJob
} from "@jazu/queue";
import {
  captureError,
  closeSentry,
  initPostHog,
  initSentry,
  installProcessErrorHandlers,
  runReadiness,
  shutdownPostHog
} from "@jazu/observability";
import { env } from "./env.js";
import { handleWaInbound } from "./handlers/wa-inbound.js";
import { handleWaFlush } from "./handlers/wa-flush.js";
import { handleLeadNotify } from "./handlers/lead-notify.js";
import { handleStyleAnalyze } from "./handlers/style-analyze.js";
import { handleFollowup } from "./handlers/followup.js";
import { handleWaDelivery } from "./handlers/wa-delivery.js";
import { logger } from "./logger.js";
import { startRetentionCron } from "./retention.js";
import { startSubscriptionRemindersCron } from "./subscription-reminders.js";
import { startWaDeliveryWatchdogCron } from "./wa-delivery-watchdog.js";

initSentry({
  service: "jobs",
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  ...(env.RELEASE_VERSION ? { release: env.RELEASE_VERSION } : {})
});
initPostHog({ token: env.POSTHOG_PROJECT_TOKEN, host: env.POSTHOG_HOST });
installProcessErrorHandlers("jobs");

logger.info(
  { concurrency: env.JOBS_CONCURRENCY, redis: env.REDIS_URL.replace(/(:\/\/)([^@]+)@/, "$1***@") },
  "jobs worker boot"
);

const waInboundWorker = startWorker<WaInboundJob>(QUEUE_WA_INBOUND, handleWaInbound, {
  concurrency: env.JOBS_CONCURRENCY,
  lockDuration: env.JOBS_INBOUND_TIMEOUT_MS
});

waInboundWorker.worker.on("ready", () => {
  logger.info({ queue: QUEUE_WA_INBOUND }, "worker ready");
});

// Фаза flush: склейка нескольких входящих клиента в ОДИН ответ. Здесь живёт
// LLM-вызов (переехал из inbound), поэтому lockDuration держим как у inbound —
// иначе при дефолтных 30с < времени LLM задача потеряет lock и BullMQ повторит
// её → двойной ответ.
const waFlushWorker = startWorker<WaFlushJob>(QUEUE_WA_FLUSH, handleWaFlush, {
  concurrency: env.JOBS_CONCURRENCY,
  lockDuration: env.JOBS_INBOUND_TIMEOUT_MS
});

waFlushWorker.worker.on("ready", () => {
  logger.info({ queue: QUEUE_WA_FLUSH }, "worker ready");
});

waFlushWorker.worker.on("failed", (job, err) => {
  captureError(err, {
    route: "jobs:wa-flush",
    requestId: (job?.data)?.requestId ?? null,
    agentId: (job?.data)?.agentId ?? null,
    extra: { jobId: job?.id, attemptsMade: job?.attemptsMade, maxAttempts: job?.opts.attempts }
  });
});

// Отложенная отправка карточек лидов (придержка ~2 мин для «номера для связи»).
const leadNotifyWorker = startWorker<LeadNotifyJob>(QUEUE_LEAD_NOTIFY, handleLeadNotify, {
  concurrency: 5
});

leadNotifyWorker.worker.on("ready", () => {
  logger.info({ queue: QUEUE_LEAD_NOTIFY }, "worker ready");
});

leadNotifyWorker.worker.on("failed", (job, err) => {
  captureError(err, {
    route: "jobs:lead-notify",
    agentId: (job?.data)?.agentId ?? null,
    extra: { jobId: job?.id, leadId: (job?.data)?.leadId ?? null }
  });
});

// Анализ стиля владельца (фича «бот в стиле владельца»). Долгий (сотни LLM-вызовов):
// concurrency=1, чтобы один тяжёлый прогон не выедал ключи/бюджет параллельно с
// боевыми ответами. lockDuration большой — задача идёт минутами.
const styleAnalyzeWorker = startWorker<StyleAnalyzeJob>(QUEUE_STYLE_ANALYZE, handleStyleAnalyze, {
  concurrency: 1,
  lockDuration: 10 * 60 * 1000
});

styleAnalyzeWorker.worker.on("ready", () => {
  logger.info({ queue: QUEUE_STYLE_ANALYZE }, "worker ready");
});

styleAnalyzeWorker.worker.on("failed", (job, err) => {
  captureError(err, {
    route: "jobs:style-analyze",
    agentId: (job?.data)?.agentId ?? null,
    extra: { jobId: job?.id, attemptsMade: job?.attemptsMade }
  });
});

// Дожим клиента (follow-up): напоминания по серии шагов, если клиент замолчал.
const followupWorker = startWorker<FollowupJob>(QUEUE_WA_FOLLOWUP, handleFollowup, {
  concurrency: 5
});

followupWorker.worker.on("ready", () => {
  logger.info({ queue: QUEUE_WA_FOLLOWUP }, "worker ready");
});

followupWorker.worker.on("failed", (job, err) => {
  captureError(err, {
    route: "jobs:wa-followup",
    agentId: (job?.data)?.agentId ?? null,
    extra: { jobId: job?.id, attempt: (job?.data)?.attempt ?? null }
  });
});

// Статус доставки пузырей мультисообщения (wa-worker сам в Postgres не пишет —
// шлёт сюда). Fire-and-forget с точки зрения отправки, поэтому concurrency
// повыше: задачи маленькие (один UPDATE), а поток может быть частым.
const waDeliveryWorker = startWorker<WaDeliveryJob>(QUEUE_WA_DELIVERY, handleWaDelivery, {
  concurrency: 10
});

waDeliveryWorker.worker.on("ready", () => {
  logger.info({ queue: QUEUE_WA_DELIVERY }, "worker ready");
});

waDeliveryWorker.worker.on("failed", (job, err) => {
  captureError(err, {
    route: "jobs:wa-delivery",
    extra: {
      jobId: job?.id,
      outboundMessageId: (job?.data)?.outboundMessageId ?? null,
      index: (job?.data)?.index ?? null
    }
  });
});

waInboundWorker.worker.on("completed", (job) => {
  logger.debug({ jobId: job.id }, "job completed");
});

waInboundWorker.worker.on("failed", (job, err) => {
  captureError(err, {
    route: "jobs:wa-inbound",
    requestId: (job?.data)?.requestId ?? null,
    agentId: (job?.data)?.agentId ?? null,
    extra: {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      maxAttempts: job?.opts.attempts
    }
  });
});

// Daily retention sweep — чистит WaMessage / LlmCallLog старше N дней.
const stopRetention = startRetentionCron(env.RETENTION_DAYS);

// Daily — напоминания об окончании тарифа / исчерпании диалогов (WA + email).
const stopSubReminders = startSubscriptionRemindersCron();

// Сторожевой таймер доставки мультисообщений — без него потеря пузыря
// (WaMessageDelivery застрял в pending) невидима никому.
const stopWaDeliveryWatchdog = startWaDeliveryWatchdogCron(
  env.WA_DELIVERY_STALE_MS,
  env.WA_DELIVERY_WATCHDOG_INTERVAL_MS
);

// Маленький Fastify-сервер для k8s/Compose healthcheck'ов. Только /healthz и /readyz.
const health = Fastify({ logger: false, trustProxy: true });
health.get("/healthz", async () => ({ ok: true, service: "jobs", at: new Date().toISOString() }));
health.get("/readyz", async (_request, reply) => {
  const report = await runReadiness("jobs", [
    {
      name: "postgres",
      check: async () => {
        await prisma.$queryRaw`SELECT 1`;
      }
    },
    {
      name: "redis",
      check: async () => {
        const pong = await getRedisWriter().ping();
        if (pong !== "PONG") throw new Error(`unexpected redis reply: ${String(pong)}`);
      }
    },
    {
      name: "worker",
      check: async () => {
        if (!waInboundWorker.worker.isRunning()) {
          throw new Error("wa-inbound worker not running");
        }
        if (!waFlushWorker.worker.isRunning()) {
          throw new Error("wa-flush worker not running");
        }
      }
    }
  ]);
  if (!report.ok) reply.code(503);
  return report;
});

try {
  await health.listen({ port: env.JOBS_HEALTH_PORT, host: "0.0.0.0" });
  logger.info({ port: env.JOBS_HEALTH_PORT }, "health server listening");
} catch (err) {
  logger.error({ err }, "failed to start health server");
  process.exit(1);
}

/**
 * Graceful shutdown. SIGTERM приходит от docker/k8s/PM при рестарте.
 * Закрываем воркер (дожидается окончания текущих задач), затем коннекшены.
 * Если кто-то не успевает завершиться за 30 сек — выходим жёстко.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "jobs worker shutting down");
  const hardExitTimer = setTimeout(() => {
    logger.error("graceful shutdown timed out — force exit");
    process.exit(1);
  }, 30_000);
  hardExitTimer.unref();

  stopRetention();
  stopSubReminders();
  stopWaDeliveryWatchdog();

  try {
    await health.close();
  } catch (err) {
    logger.error({ err }, "error closing health server");
  }
  try {
    await waInboundWorker.close();
  } catch (err) {
    logger.error({ err }, "error closing wa:inbound worker");
  }
  try {
    await waFlushWorker.close();
  } catch (err) {
    logger.error({ err }, "error closing wa:flush worker");
  }
  try {
    await leadNotifyWorker.close();
  } catch (err) {
    logger.error({ err }, "error closing lead-notify worker");
  }
  try {
    await styleAnalyzeWorker.close();
  } catch (err) {
    logger.error({ err }, "error closing style-analyze worker");
  }
  try {
    await waDeliveryWorker.close();
  } catch (err) {
    logger.error({ err }, "error closing wa:delivery worker");
  }
  try {
    await followupWorker.close();
  } catch (err) {
    logger.error({ err }, "error closing wa:followup worker");
  }
  try {
    await closeAllQueues();
    await closeRedisWriter();
  } catch (err) {
    logger.error({ err }, "error closing queues/redis");
  }
  try {
    await closeSentry();
  } catch (err) {
    logger.error({ err }, "error closing sentry");
  }
  try {
    await shutdownPostHog();
  } catch (err) {
    logger.error({ err }, "error closing posthog");
  }
  clearTimeout(hardExitTimer);
  logger.info("jobs worker stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
