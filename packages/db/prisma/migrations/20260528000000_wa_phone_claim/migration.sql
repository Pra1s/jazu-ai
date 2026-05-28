-- Реестр «WA-номеров, застолблённых пользователями».
-- Один и тот же WhatsApp-номер можно привязать только к ОДНОМУ аккаунту Jazu.
-- phoneHash = HMAC-SHA256(digits, env.PHONE_HASH_PEPPER) в hex.
-- Создаётся атомарно в момент успешного pairing (connection.update→open).
CREATE TABLE "WaPhoneClaim" (
    "id"           TEXT NOT NULL,
    "phoneHash"    TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "agentId"      TEXT,
    "firstBoundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBoundAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaPhoneClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WaPhoneClaim_phoneHash_key" ON "WaPhoneClaim"("phoneHash");
CREATE INDEX "WaPhoneClaim_userId_idx" ON "WaPhoneClaim"("userId");

ALTER TABLE "WaPhoneClaim"
  ADD CONSTRAINT "WaPhoneClaim_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
