-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "botModel" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "detectedNeed" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "detectedNeed" TEXT;
