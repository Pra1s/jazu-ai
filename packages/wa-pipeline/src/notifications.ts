/**
 * Telegram notification helper, изолированный от env api/jobs — токен
 * передаётся параметром, чтобы пакет мог использоваться из любого сервиса.
 *
 * Не бросает наружу: ошибки доставки телеграма не должны валить
 * основной inbound-pipeline. Просто пишем в console.error.
 */
export async function sendTelegramLead(
  botToken: string | undefined,
  chatId: string,
  text: string
): Promise<void> {
  if (!botToken) return;

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    if (!response.ok) {
      console.error(
        "[wa-pipeline] telegram lead failed:",
        response.status,
        await response.text().catch(() => "")
      );
    }
  } catch (err) {
    console.error("[wa-pipeline] telegram lead error:", err instanceof Error ? err.message : err);
  }
}

/** Только цифры (без +, пробелов, скобок). Для построения WhatsApp JID. */
function phoneDigits(phone: string): string {
  return phone.replace(/\D+/g, "");
}

export type WhatsappOwnerNotificationParams = {
  /** Базовый URL wa-worker (env.WA_WORKER_URL). Без него — no-op. */
  workerUrl: string | undefined;
  /** Internal-токен для авторизации в wa-worker. */
  internalToken: string;
  /** Агент, через бота которого отправляем. */
  agentId: string;
  /** Личный номер владельца (User.phone) в любом формате. */
  personalPhone: string;
  /** Номер бизнес-WhatsApp (WaConnection.phone). Может быть null. */
  botPhone: string | null | undefined;
  /** Текст уведомления (plain). */
  text: string;
};

/**
 * Отправить владельцу агента уведомление о лиде в WhatsApp через его же бота.
 *
 * Логика адресата:
 *   - Если личный номер совпадает с номером бизнес-WhatsApp (после
 *     нормализации до чистых цифр) — бот пишет «сам себе»: WhatsApp откроет
 *     системный чат «Сообщения себе». JID при этом всё равно строится из
 *     цифр бота — отправка на свой же номер именно так и работает.
 *   - Иначе — пишем на личный номер: `${digits}@s.whatsapp.net`.
 *
 * Best-effort: ошибки доставки логируем, но НЕ бросаем — это не должно
 * валить inbound-pipeline (лид уже создан в БД).
 */
export async function sendWhatsappOwnerNotification(
  params: WhatsappOwnerNotificationParams
): Promise<void> {
  const { workerUrl, internalToken, agentId, personalPhone, botPhone, text } = params;
  if (!workerUrl) return;

  const personalDigits = phoneDigits(personalPhone);
  if (!personalDigits) return;

  const botDigits = botPhone ? phoneDigits(botPhone) : "";
  // Если личный == бот → отправляем на цифры бота (= себе). Иначе на личный.
  const targetDigits = botDigits && botDigits === personalDigits ? botDigits : personalDigits;
  const chatId = `${targetDigits}@s.whatsapp.net`;

  try {
    const response = await fetch(new URL(`/connections/${agentId}/send`, workerUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": internalToken
      },
      body: JSON.stringify({ chatId, text })
    });
    if (!response.ok) {
      console.error(
        "[wa-pipeline] owner WA notification failed:",
        response.status,
        await response.text().catch(() => "")
      );
    }
  } catch (err) {
    console.error(
      "[wa-pipeline] owner WA notification error:",
      err instanceof Error ? err.message : err
    );
  }
}
