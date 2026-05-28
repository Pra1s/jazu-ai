-- Снимок чатов, существовавших в WhatsApp ДО подключения бота.
-- Заполняется из history-sync при первой привязке. Бот в этих чатах молчит.
CREATE TABLE "WaPreConnectionChat" (
    "id"        TEXT NOT NULL,
    "agentId"   TEXT NOT NULL,
    "waChatId"  TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaPreConnectionChat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WaPreConnectionChat_agentId_waChatId_key"
  ON "WaPreConnectionChat"("agentId", "waChatId");
CREATE INDEX "WaPreConnectionChat_agentId_idx"
  ON "WaPreConnectionChat"("agentId");

ALTER TABLE "WaPreConnectionChat"
  ADD CONSTRAINT "WaPreConnectionChat_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
