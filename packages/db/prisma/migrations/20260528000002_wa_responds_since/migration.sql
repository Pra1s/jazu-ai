-- Бот отвечает только на сообщения и чаты «после подключения».
-- Защита от history-sync flood (WhatsApp при connection шлёт пачку
-- старых непрочитанных сообщений за последний месяц) и от того,
-- чтобы бот не вторгался в существующие чаты юзера.
ALTER TABLE "WaConnection"
  ADD COLUMN "botRespondsSince" TIMESTAMP(3);

-- Backfill: для уже подключённых юзеров считаем «отсечка = сейчас».
-- Это значит: на момент выкатки этой миграции все существующие
-- Conversation становятся «доконнектными», бот в них не лезет.
-- Если хочется иначе — поле можно вручную обнулить через UPDATE.
UPDATE "WaConnection"
   SET "botRespondsSince" = NOW()
 WHERE status = 'connected';
