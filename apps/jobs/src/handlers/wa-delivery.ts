import type { Job, WaDeliveryJob } from "@jazu/queue";
import { prisma } from "@jazu/db";
import { logger } from "../logger.js";

/**
 * Обработчик очереди wa:delivery — статус доставки ОДНОГО пузыря мультисообщения.
 *
 * wa-worker не имеет доступа к Postgres (изоляция, см.
 * apps/wa-worker/src/db-auth-state.ts), поэтому шлёт статус сюда fire-and-forget
 * задачей вместо прямой записи. Строка WaMessageDelivery уже существует (создана
 * в той же транзакции, что и сам WaMessage — см. flushWaConversation в
 * packages/wa-pipeline/src/handler.ts) со статусом "pending"; здесь только
 * обновляем её.
 *
 * updateMany, а не update: если строка не найдена (гонка/старая задача с
 * предыдущего деплоя без outboundMessageId) — best-effort лог, не падаем и не
 * ретраим бесконечно из-за одной несуществующей строки.
 */
export async function handleWaDelivery(job: Job<WaDeliveryJob>): Promise<void> {
  const { outboundMessageId, index, status, waMsgId, error } = job.data;

  const result = await prisma.waMessageDelivery.updateMany({
    where: { waMessageId: outboundMessageId, index },
    data: {
      status,
      ...(waMsgId !== undefined ? { waMsgId } : {}),
      ...(error !== undefined ? { error: error.slice(0, 500) } : {}),
      ...(status === "sent" ? { sentAt: new Date() } : {})
    }
  });

  if (result.count === 0) {
    logger.warn(
      { outboundMessageId, index, status },
      "wa-delivery: строка WaMessageDelivery не найдена (гонка или задача без outboundMessageId)"
    );
    return;
  }

  logger.debug({ outboundMessageId, index, status }, "wa-delivery: статус обновлён");
}
