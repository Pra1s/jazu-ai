import type { Job, LeadNotifyJob } from "@jazu/queue";
import { notifyLeadById } from "@jazu/wa-pipeline";
import { prisma } from "@jazu/db";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Обработчик отложенного задания lead-notify.
 *
 * Карточку лида придерживаем на ~2 мин после закрытия (см. writeLeadIfNeeded),
 * чтобы за это окно в lead.fields успел попасть «номер для связи». Когда задание
 * срабатывает — отправляем владельцу ОДНУ полную карточку. notifyLeadById
 * идемпотентна: если карточка уже ушла (эскалация и т.п.) — выходит молча.
 */
export async function handleLeadNotify(job: Job<LeadNotifyJob>): Promise<void> {
  const { leadId, agentId } = job.data;
  await notifyLeadById(prisma, leadId, agentId, {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    workerUrl: env.WA_WORKER_URL,
    internalToken: env.API_INTERNAL_TOKEN
  });
  logger.info({ leadId, agentId, jobId: job.id }, "lead-notify delivered");
}
