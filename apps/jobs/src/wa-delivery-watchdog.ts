import { prisma } from "@jazu/db";
import { captureError } from "@jazu/observability";
import { logger } from "./logger.js";

/**
 * Ищет пузыри мультисообщения, застрявшие в статусе "pending" дольше staleMs.
 * Без этой проверки WaMessageDelivery — просто ещё одна таблица, куда никто не
 * смотрит: потерянный пузырь молча остаётся pending навсегда, а строка WaMessage
 * (полный текст ответа) в кабинете выглядит как обычный, «доставленный» ответ.
 */
export async function checkStaleDeliveries(staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await prisma.waMessageDelivery.findMany({
    where: { status: "pending", createdAt: { lt: cutoff } },
    select: { id: true, waMessageId: true, index: true, createdAt: true },
    take: 200
  });

  if (stale.length === 0) return 0;

  logger.error(
    { count: stale.length, sample: stale.slice(0, 5) },
    "wa-delivery-watchdog: найдены зависшие pending-доставки"
  );
  captureError(new Error(`${stale.length} WaMessageDelivery застряли в pending дольше ${staleMs}мс`), {
    route: "jobs:wa-delivery-watchdog",
    extra: { count: stale.length, sampleIds: stale.slice(0, 20).map((d) => d.id) }
  });

  return stale.length;
}

/**
 * Планировщик: проверяет зависшие доставки раз в intervalMs. В отличие от
 * retention (раз в сутки в фиксированный час) — здесь интервал, а не
 * расписание: цель поймать потерю в разумное время после самой потери, а не
 * раз в день.
 */
export function startWaDeliveryWatchdogCron(staleMs: number, intervalMs: number): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void checkStaleDeliveries(staleMs).catch((err) => {
      logger.error({ err }, "wa-delivery-watchdog: проверка упала");
      captureError(err, { route: "jobs:wa-delivery-watchdog" });
    });
  }, intervalMs);
  timer.unref();
  logger.info({ staleMs, intervalMs }, "wa-delivery-watchdog: запущен");

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
