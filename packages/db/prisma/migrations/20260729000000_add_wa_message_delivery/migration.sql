-- Статус доставки КАЖДОГО пузыря мультисообщения (см. комментарий на модели
-- WaMessageDelivery в schema.prisma). Чисто добавочная миграция: новый enum,
-- новая таблица, новый FK на существующую WaMessage — существующие данные и
-- запросы не затрагиваются.

-- CreateEnum
CREATE TYPE "WaDeliveryStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "WaMessageDelivery" (
    "id"          TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "index"       INTEGER NOT NULL,
    "text"        TEXT NOT NULL,
    "status"      "WaDeliveryStatus" NOT NULL DEFAULT 'pending',
    "waMsgId"     TEXT,
    "error"       TEXT,
    "sentAt"      TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaMessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaMessageDelivery_waMessageId_index_key" ON "WaMessageDelivery"("waMessageId", "index");
CREATE INDEX "WaMessageDelivery_status_createdAt_idx" ON "WaMessageDelivery"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "WaMessageDelivery" ADD CONSTRAINT "WaMessageDelivery_waMessageId_fkey" FOREIGN KEY ("waMessageId") REFERENCES "WaMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
