import type { Logger } from "pino";
import { prisma } from "@jazu/db";
import { capturePostHog } from "@jazu/observability";

/**
 * Разовая отметка активации владельца: bot_activated = «бот реально обработал
 * первый живой диалог» (ответил живому клиенту). Атомарный updateMany с guard
 * botActivatedAt=null — если строка обновилась, активация первая → шлём событие.
 * Исключает повторы и гонки между параллельными воркерами. Ошибку БД глушим —
 * аналитика не должна ронять обработку.
 */
export async function markBotActivatedOnce(
  agentOwnerUserId: string,
  agentId: string,
  log: Logger
): Promise<void> {
  try {
    const activated = await prisma.user.updateMany({
      where: { id: agentOwnerUserId, botActivatedAt: null },
      data: { botActivatedAt: new Date() }
    });
    if (activated.count > 0) {
      capturePostHog({
        distinctId: agentOwnerUserId,
        event: "bot_activated",
        properties: { agentId }
      });
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "bot_activated mark failed");
  }
}
