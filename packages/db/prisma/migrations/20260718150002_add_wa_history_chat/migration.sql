-- Буфер личных диалогов из WhatsApp history-sync (продуктовый источник фичи
-- «бот в стиле владельца»): захват воркером → выбор чатов в UI → анализ.

-- CreateTable
CREATE TABLE "WaHistoryChat" (
    "id"           TEXT NOT NULL,
    "agentId"      TEXT NOT NULL,
    "waChatId"     TEXT NOT NULL,
    "label"        TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "messages"     JSONB NOT NULL,
    "selected"     BOOLEAN NOT NULL DEFAULT false,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaHistoryChat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaHistoryChat_agentId_waChatId_key" ON "WaHistoryChat"("agentId", "waChatId");
CREATE INDEX "WaHistoryChat_agentId_idx" ON "WaHistoryChat"("agentId");

-- AddForeignKey
ALTER TABLE "WaHistoryChat"
  ADD CONSTRAINT "WaHistoryChat_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
