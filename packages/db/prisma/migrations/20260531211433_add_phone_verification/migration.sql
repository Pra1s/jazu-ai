-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phonePending" TEXT,
ADD COLUMN     "phoneVerifyAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "phoneVerifyCode" TEXT,
ADD COLUMN     "phoneVerifyExpiresAt" TIMESTAMP(3);
