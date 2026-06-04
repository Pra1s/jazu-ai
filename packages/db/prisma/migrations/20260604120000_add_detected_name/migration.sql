-- AlterEnum
ALTER TYPE "PromptSource" ADD VALUE 'enrichment';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "detectedName" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "detectedName" TEXT;
