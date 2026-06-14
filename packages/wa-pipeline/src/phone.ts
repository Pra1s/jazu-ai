// Резолв телефона клиента для карточки лида.
//
// Проблема: WhatsApp с приватностью адресует чат через LID (`<lid>@lid`) — это
// НЕ номер телефона, а внутренний linked-id (напр. «277657472258270», 15 цифр).
// Реальный номер приходит отдельно: воркер достаёт его из ключа сообщения
// (remoteJid/remoteJidAlt — у lid-чата PN лежит в remoteJidAlt) и кладёт в
// поле senderPhone. Поэтому НЕЛЬЗЯ брать user-part из любого chatId вслепую —
// для @lid это даст мусорный id на карточке.

/**
 * Достаёт цифры номера из WhatsApp-JID, ТОЛЬКО если это PN-адрес
 * (`<номер>@s.whatsapp.net`). Для @lid и прочих не-PN возвращает null —
 * lid это не телефон.
 */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  if (at < 0 || jid.slice(at + 1) !== "s.whatsapp.net") return null;
  // user может нести суффикс устройства "<номер>:<device>" — отбрасываем его.
  // Строгая проверка (а не strip нецифр): не чистые цифры → null, номер НЕ фабрикуем.
  const user = jid.slice(0, at).split(":")[0] ?? "";
  return /^\d{7,15}$/.test(user) ? user : null;
}

/** Нормализует номер, названный клиентом в переписке (берём только цифры). */
export function normalizeStatedPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  return /^\d{7,15}$/.test(digits) ? digits : null;
}

/**
 * Два телефона для карточки лида:
 *   - whatsappPhone — базовый номер чата (реальный WA-номер): senderPhone (резолв
 *     lid→pn в воркере) → user-part chatId только если это PN. lid номером НЕ считаем.
 *   - contactPhone — номер, который клиент НАЗВАЛ в чате как «свяжитесь по этому»
 *     (extractedPhone). Показываем ТОЛЬКО если он отличается от WA-номера (иначе дубль).
 */
export function resolveLeadPhones(args: {
  chatId: string;
  senderPhone?: string | null | undefined;
  extractedPhone?: string | null | undefined;
}): { whatsappPhone: string | null; contactPhone: string | null } {
  const whatsappPhone = normalizeStatedPhone(args.senderPhone) ?? phoneFromJid(args.chatId);
  const stated = normalizeStatedPhone(args.extractedPhone);
  const contactPhone = stated && stated !== whatsappPhone ? stated : null;
  return { whatsappPhone, contactPhone };
}
