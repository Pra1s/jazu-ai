-- RAG по стилю владельца: расширение pgvector + таблица обменов с эмбеддингами.
-- ВАЖНО: образ Postgres должен включать расширение vector (см. docker-compose).

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "StyleExchange" (
    "id"             TEXT NOT NULL,
    "agentId"        TEXT NOT NULL,
    "dialogueCardId" TEXT,
    "situation"      TEXT NOT NULL DEFAULT '',
    "clientText"     TEXT NOT NULL DEFAULT '',
    "ownerText"      TEXT NOT NULL,
    "embedding"      vector(1536),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StyleExchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StyleExchange_agentId_idx" ON "StyleExchange"("agentId");

-- AddForeignKey
ALTER TABLE "StyleExchange"
  ADD CONSTRAINT "StyleExchange_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
