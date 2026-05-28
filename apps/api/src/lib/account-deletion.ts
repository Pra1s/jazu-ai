import { prisma, Prisma } from "@jazu/db";

/**
 * Удаление аккаунта пользователя (GDPR art.17 / 152-ФЗ «право на забвение»).
 *
 * Что делаем:
 *   - Стираем PII у User: email/name/phone/googleId/avatarUrl/telegramChatId.
 *     Email заменяем на placeholder `deleted_<id>@deleted.local`, чтобы не
 *     заблокировать unique-индекс для будущих регистраций (другой человек
 *     может захотеть зарегаться с тем же email через год).
 *   - Ставим deletedAt — после этого юзер не сможет залогиниться даже если
 *     каким-то чудом сохранил cookie.
 *   - Удаляем все sessions, agents (Cascade сносит businessProfile/prompts/
 *     conversations/wa/leads/messages), magic-link tokens по email.
 *
 * Что сохраняем (обезличенно):
 *   - WaPhoneClaim — phoneHash живёт, userId обнуляется (анти-абуз).
 *   - Purchase — для бухгалтерии (НК РФ требует хранить чеки 5 лет).
 *   - LlmCallLog — для агрегированной аналитики costs.
 *   - UsageEvent — для агрегированного учёта.
 *   - AuditLog — для разбора инцидентов (compliance).
 *
 * Атомарно через $transaction: либо всё, либо ничего. Если упадём
 * посередине — БД останется в консистентном состоянии.
 */
export async function deleteUserAccount(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, deletedAt: true }
    });
    if (!user) {
      throw new Error(`deleteUserAccount: user not found: ${userId}`);
    }
    if (user.deletedAt) {
      // Идемпотентность: повторный вызов — no-op.
      return;
    }

    // 1. Удаляем все magic-link токены этого пользователя (по email).
    //    После замены email мы их уже не найдём, поэтому делаем ДО update.
    await tx.magicLinkToken.deleteMany({
      where: { email: user.email }
    });

    // 2. Удаляем все агенты — Cascade снесёт:
    //    businessProfile, promptVersions, builderMessages, testMessages,
    //    waConnections (с creds), conversations → waMessages + leads.
    await tx.agent.deleteMany({
      where: { userId }
    });

    // 3. Обезличиваем WaPhoneClaim — userId в null, phoneHash живёт.
    //    SetNull уже сработал бы при delete user, но мы НЕ удаляем user
    //    (только soft-delete), поэтому делаем явно.
    await tx.waPhoneClaim.updateMany({
      where: { userId },
      data: { userId: null, agentId: null }
    });

    // 4. Обезличиваем Purchase/LlmCallLog/UsageEvent — userId → null.
    //    Эти записи остаются как агрегированные/бухгалтерские, без связи
    //    с конкретным человеком.
    await tx.purchase.updateMany({
      where: { userId },
      data: { userId: null }
    });
    await tx.llmCallLog.updateMany({
      where: { userId },
      data: { userId: null }
    });
    await tx.usageEvent.updateMany({
      where: { userId },
      data: { userId: null }
    });

    // 5. AuditLog: оставляем как есть. userId там уже nullable и используется
    //    только для поиска истории действий. По 152-ФЗ ст. 18.1 ч.3 логи
    //    доступа можно хранить как «выполнение обязанностей оператора».
    //    Если регулятор когда-нибудь скажет иначе — отдельным релизом.

    // 6. Удаляем все сессии — все активные cookie мгновенно теряют доступ.
    await tx.session.deleteMany({
      where: { userId }
    });

    // 7. Стираем PII у самого User. Уникальные поля переводим в безопасное
    //    состояние, чтобы освободить unique-индекс для будущих регистраций.
    await tx.user.update({
      where: { id: userId },
      data: {
        email: `deleted_${userId}@deleted.local`,
        name: null,
        phone: null,
        phoneVerifiedAt: null,
        googleId: null,
        avatarUrl: null,
        telegramChatId: null,
        onboardingState: Prisma.JsonNull,
        deletedAt: new Date()
      }
    });
  }, {
    // У нас тут много шагов, расширяем timeout. Дефолт Prisma = 5s.
    timeout: 30_000
  });
}
