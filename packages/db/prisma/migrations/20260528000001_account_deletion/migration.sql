-- Account deletion (GDPR/152-ФЗ «право на забвение»).
-- Стратегия: обезличиваем User (стираем PII, ставим deletedAt), но сам ряд
-- оставляем, чтобы FK на Purchase/LlmCallLog/UsageEvent/WaPhoneClaim не
-- упали в каскад. Так история транзакций и анти-абуз claim'ы сохраняются.

-- 1. User.deletedAt: фильтр «удалён ли аккаунт».
ALTER TABLE "User"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

-- 2. WaPhoneClaim: userId nullable + SetNull.
ALTER TABLE "WaPhoneClaim"
  DROP CONSTRAINT "WaPhoneClaim_userId_fkey";

ALTER TABLE "WaPhoneClaim"
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "WaPhoneClaim"
  ADD CONSTRAINT "WaPhoneClaim_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Purchase: userId nullable + SetNull. Бухгалтерия требует сохранять
--    записи о транзакциях даже после удаления аккаунта.
ALTER TABLE "Purchase"
  DROP CONSTRAINT "Purchase_userId_fkey";

ALTER TABLE "Purchase"
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "Purchase"
  ADD CONSTRAINT "Purchase_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. UsageEvent: userId nullable + SetNull. Postgres UNIQUE с NULL разрешает
--    множественные NULL, конфликтов по (userId, chatId, periodKey) не будет.
ALTER TABLE "UsageEvent"
  DROP CONSTRAINT "UsageEvent_userId_fkey";

ALTER TABLE "UsageEvent"
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
