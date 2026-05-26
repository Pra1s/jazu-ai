import { env } from "../env.js";

export async function sendMagicLinkEmail(email: string, link: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [email],
      subject: "Вход в Chatera-like MVP",
      html: `<p>Ссылка для входа:</p><p><a href="${link}">${link}</a></p>`
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to send magic link email: ${response.status} ${await response.text()}`);
  }
}

/**
 * Отправляет одноразовый 6-значный код для входа. В отличие от ссылки, код
 * вводится юзером в том же браузере, где он открыл /auth — это решает
 * проблему с Gmail/Outlook WebView, которые открывают ссылки в собственном
 * окружении и логинят не туда, где юзер начал.
 */
export async function sendMagicCodeEmail(email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    return;
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h1 style="font-size: 18px; margin: 0 0 16px 0;">Код для входа в Jazu</h1>
      <p style="font-size: 15px; line-height: 1.5; color: #444; margin: 0 0 20px 0;">
        Введите этот код на странице входа:
      </p>
      <div style="font-size: 32px; font-weight: 600; letter-spacing: 0.18em; padding: 16px 24px; background: #f4f4f5; border-radius: 12px; text-align: center; font-family: 'SF Mono', Menlo, Consolas, monospace;">
        ${code}
      </div>
      <p style="font-size: 13px; color: #888; margin: 20px 0 0 0;">
        Код действует 15 минут. Если вы не запрашивали вход — просто проигнорируйте письмо.
      </p>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [email],
      subject: `${code} — код для входа в Jazu`,
      html
    })
  });

  if (!response.ok) {
    throw new Error(
      `Failed to send magic code email: ${response.status} ${await response.text()}`
    );
  }
}

export async function sendTelegramLead(chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to send Telegram lead: ${response.status} ${await response.text()}`);
  }
}
