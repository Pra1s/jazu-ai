-- Глобальный «выключатель» бота на уровне агента.
-- Когда botEnabled=false, wa-pipeline не отвечает и не сохраняет inbound от клиента.
ALTER TABLE "Agent"
  ADD COLUMN "botEnabled" BOOLEAN NOT NULL DEFAULT true;
