import type { FastifyRequest } from "fastify";
import { prisma, type Prisma } from "@jazu/db";

/**
 * Перечень всех аудируемых событий. Жёсткий список (без свободной строки),
 * чтобы не плодить варианты типа "login_success" / "login.success" / "loginOk".
 */
export type AuditEvent =
  | "login.success"
  | "login.failed"
  | "logout"
  | "magic_link.issued"
  | "magic_link.consumed"
  | "magic_link.expired"
  | "google.linked"
  | "phone.updated"
  | "wa.pair_requested"
  | "wa.paired"
  | "wa.disconnected"
  | "wa.phone_claimed"
  | "wa.phone_claim_rejected"
  | "purchase.completed"
  | "purchase.failed"
  | "session.revoked";

type AuditOptions = {
  event: AuditEvent;
  userId?: string | null;
  request?: Pick<FastifyRequest, "ip" | "headers" | "id"> | null;
  metadata?: Record<string, unknown>;
};

/**
 * Записывает событие в AuditLog. Никогда не бросает ошибку наружу — потеря
 * аудит-записи не должна сломать пользовательский флоу (логин/покупку). На
 * случай падения пишем в console.error, чтобы можно было заметить.
 *
 * IP режется до 64 символов (длинный IPv6 + порт = ~50), UA до 256 — чтобы
 * не получить расхождение с другими сервисами при гигантских заголовках.
 */
export async function recordAudit(options: AuditOptions): Promise<void> {
  try {
    const ip = options.request?.ip ?? null;
    const uaRaw = options.request?.headers["user-agent"];
    const userAgent = typeof uaRaw === "string" ? uaRaw.slice(0, 256) : null;
    const requestId = typeof options.request?.id === "string" ? options.request.id : null;

    await prisma.auditLog.create({
      data: {
        event: options.event,
        userId: options.userId ?? null,
        ip: ip ? ip.slice(0, 64) : null,
        userAgent,
        requestId,
        ...(options.metadata !== undefined
          ? { metadata: options.metadata as Prisma.InputJsonValue }
          : {})
      }
    });
  } catch (err) {
    console.error("[audit] failed to write log:", err instanceof Error ? err.message : err);
  }
}
