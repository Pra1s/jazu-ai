-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "carcass" TEXT;

-- AlterTable
ALTER TABLE "PromptVersion" ADD COLUMN     "correctionType" TEXT,
ADD COLUMN     "sectionEdited" TEXT;
