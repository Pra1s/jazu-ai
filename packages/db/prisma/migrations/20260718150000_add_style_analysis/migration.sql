-- Фича «бот в стиле владельца»: карточки анализа диалогов + состояние прогона.

-- CreateTable
CREATE TABLE "DialogueCard" (
    "id"              TEXT NOT NULL,
    "agentId"         TEXT NOT NULL,
    "sourceChatLabel" TEXT NOT NULL DEFAULT '',
    "episodeIndex"    INTEGER NOT NULL DEFAULT 0,
    "card"            JSONB NOT NULL,
    "excerpts"        JSONB NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DialogueCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DialogueCard_agentId_idx" ON "DialogueCard"("agentId");

-- CreateTable
CREATE TABLE "StyleAnalysis" (
    "id"                TEXT NOT NULL,
    "agentId"           TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'pending',
    "stage"             TEXT NOT NULL DEFAULT '',
    "ownerName"         TEXT NOT NULL DEFAULT '',
    "totalEpisodes"     INTEGER NOT NULL DEFAULT 0,
    "processedEpisodes" INTEGER NOT NULL DEFAULT 0,
    "episodes"          JSONB,
    "error"             TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StyleAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StyleAnalysis_agentId_key" ON "StyleAnalysis"("agentId");

-- AddForeignKey
ALTER TABLE "DialogueCard"
  ADD CONSTRAINT "DialogueCard_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleAnalysis"
  ADD CONSTRAINT "StyleAnalysis_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
