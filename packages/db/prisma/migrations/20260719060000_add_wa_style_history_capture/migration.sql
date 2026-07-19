-- Фича «бот в стиле владельца», продуктовый источник: согласие на захват личной
-- истории из WhatsApp + прогресс подтягивания (history-sync) для статус-бара.

ALTER TABLE "WaConnection"
  ADD COLUMN "styleHistoryCapture"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "styleHistoryStatus"   TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN "styleHistoryProgress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "styleHistorySyncedAt" TIMESTAMP(3);
