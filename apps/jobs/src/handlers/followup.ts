import { type FollowupJob, type Job } from "@jazu/queue";
import { runFollowup } from "@jazu/wa-pipeline";
import { logger } from "../logger.js";

/**
 * Обработчик очереди wa-followup (дожим клиента). Тонкая обёртка над runFollowup:
 * гарды, генерация текста (пресет/авто+RAG), отправка и планирование следующего
 * шага живут в @jazu/wa-pipeline. Здесь только вызов и логирование.
 */
export async function handleFollowup(job: Job<FollowupJob>): Promise<void> {
  const { agentId, chatId, attempt } = job.data;
  const log = logger.child({ agentId, jobId: job.id, attempt });
  const result = await runFollowup(agentId, chatId, attempt);
  log.info({ chatId, result }, "wa:followup processed");
}
