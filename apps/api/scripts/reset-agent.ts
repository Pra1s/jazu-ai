/**
 * Сброс настроек бота у аккаунта «как новый» — для переподготовки/перенастройки.
 *
 * Запуск (email обязателен):
 *   pnpm --filter @jazu/api exec tsx scripts/reset-agent.ts user@example.com
 *   # dry-run (только показать, ничего не менять):
 *   pnpm --filter @jazu/api exec tsx scripts/reset-agent.ts user@example.com --dry
 *
 * Что делает (для каждого агента пользователя):
 *  - стирает переписку конструктора (BuilderMessage) и тест-песочницу (TestMessage);
 *  - удаляет историю версий промпта (PromptVersion);
 *  - сбрасывает профиль бизнеса (BusinessProfile.data) в createInitialProfile();
 *  - возвращает агента в состояние draft: currentPrompt = fallback,
 *    readyToFinalize=false, carcass/botModel=null, botEnabled=true;
 *  - сбрасывает onboardingState пользователя (прогресс онбординга/тура).
 *
 * Что НЕ трогает (намеренно):
 *  - WaConnection — подключённый WhatsApp-номер остаётся привязан;
 *  - реальные диалоги с клиентами (Conversation/WaMessage) и Lead;
 *  - квоту/тариф (quotaTotal/quotaUsed/planId).
 *
 * Идемпотентен: повторный запуск просто снова приводит к чистому состоянию.
 */
import { prisma, Prisma } from "@jazu/db";
import { createInitialProfile, buildFallbackPrompt } from "@jazu/ai";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const dry = process.argv.includes("--dry");
  if (!email) {
    console.error("Использование: tsx scripts/reset-agent.ts <email> [--dry]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: {
      id: true,
      email: true,
      agents: {
        select: {
          id: true,
          name: true,
          _count: {
            select: { builderMessages: true, testMessages: true, promptVersions: true }
          }
        }
      }
    }
  });

  if (!user) {
    console.error(`Пользователь с email ${email} не найден.`);
    process.exit(1);
  }
  if (user.agents.length === 0) {
    console.log(`У пользователя ${email} нет агентов — нечего сбрасывать.`);
    return;
  }

  const seedProfile = createInitialProfile();
  const seedPrompt = buildFallbackPrompt(seedProfile);

  for (const agent of user.agents) {
    console.log(
      `Агент ${agent.id} «${agent.name}»: ` +
        `builder=${agent._count.builderMessages}, test=${agent._count.testMessages}, ` +
        `versions=${agent._count.promptVersions}` +
        (dry ? " [dry-run, без изменений]" : "")
    );
    if (dry) continue;

    await prisma.$transaction([
      prisma.builderMessage.deleteMany({ where: { agentId: agent.id } }),
      prisma.testMessage.deleteMany({ where: { agentId: agent.id } }),
      prisma.promptVersion.deleteMany({ where: { agentId: agent.id } }),
      prisma.businessProfile.upsert({
        where: { agentId: agent.id },
        create: { agentId: agent.id, data: seedProfile },
        update: { data: seedProfile }
      }),
      prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: "draft",
          currentPrompt: seedPrompt,
          readyToFinalize: false,
          carcass: null,
          botModel: null,
          botEnabled: true
        }
      })
    ]);
    console.log(`  → сброшен в состояние draft.`);
  }

  if (!dry) {
    await prisma.user.update({
      where: { id: user.id },
      data: { onboardingState: Prisma.JsonNull }
    });
    console.log("onboardingState пользователя сброшен.");
  }

  console.log("Готово.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
