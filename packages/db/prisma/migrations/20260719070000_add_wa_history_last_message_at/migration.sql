-- Фича «бот в стиле владельца»: время самого свежего сообщения чата истории
-- WhatsApp — для сортировки и выбора «последние N диалогов» в UI.

ALTER TABLE "WaHistoryChat"
  ADD COLUMN "lastMessageAt" TIMESTAMP(3);
