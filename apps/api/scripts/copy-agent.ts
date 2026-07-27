/**
 * Копирование бота (всех настроек) с одного аккаунта на другой.
 *
 * Запуск (оба email обязательны):
 *   pnpm --filter @jazu/api exec tsx scripts/copy-agent.ts <from@mail> <to@mail>
 *   # dry-run (только показать, что будет скопировано):
 *   pnpm --filter @jazu/api exec tsx scripts/copy-agent.ts <from@mail> <to@mail> --dry
 *   # вместе с историей конструктора/теста и версиями промпта:
 *   pnpm --filter @jazu/api exec tsx scripts/copy-agent.ts <from@mail> <to@mail> --with-history
 *
 * Что копирует:
 *  - карточку агента: name, status, currentPrompt, readyToFinalize, carcass, botModel, botEnabled;
 *  - BusinessProfile.data целиком (ниша, услуги, ссылки, тон, мультисообщения,
 *    настройки дожима, стиль владельца — всё лежит там);
 *  - стиль владельца: DialogueCard + StyleExchange (эмбеддинги переносятся как есть,
 *    повторно платить за embeddings не нужно) + сводку StyleAnalysis;
 *  - опционально (--with-history): BuilderMessage, TestMessage, PromptVersion.
 *
 * Что НЕ копирует (намеренно):
 *  - WhatsApp-подключение (WaConnection) — номер у каждого аккаунта свой;
 *  - реальные диалоги/лиды (Conversation/WaMessage/Lead);
 *  - тариф и квоты (planId/quotaTotal/quotaUsed) — это про аккаунт, не про бота;
 *  - буфер истории чатов для анализа стиля (WaHistoryChat).
 *
 * Целевой агент перед копированием ЗАЧИЩАЕТСЯ (builder/test/версии/стиль),
 * поэтому отдельно запускать reset-agent.ts не нужно. Идемпотентен: повторный
 * запуск снова приводит целевой аккаунт к состоянию источника.
 *
 * Если у целевого пользователя ещё нет агента — он создаётся.
 */
import { prisma, Prisma } from "@jazu/db";
import { createInitialProfile, buildFallbackPrompt } from "@jazu/ai";

const agentSelect = {
  id: true,
  name: true,
  status: true,
  currentPrompt: true,
  readyToFinalize: true,
  carcass: true,
  botModel: true,
  botEnabled: true
} as const;

async function findAgent(email: string, kind: "источник" | "получатель") {
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true, email: true }
  });
  if (!user) {
    console.error(`Пользователь ${kind} с email ${email} не найден.`);
    process.exit(1);
  }
  const agent = await prisma.agent.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: agentSelect
  });
  return { user, agent };
}

async function main() {
  const fromEmail = process.argv[2]?.trim().toLowerCase();
  const toEmail = process.argv[3]?.trim().toLowerCase();
  const dry = process.argv.includes("--dry");
  const withHistory = process.argv.includes("--with-history");

  if (!fromEmail || !toEmail) {
    console.error(
      "Использование: tsx scripts/copy-agent.ts <email-источника> <email-получателя> [--dry] [--with-history]"
    );
    process.exit(1);
  }
  if (fromEmail === toEmail) {
    console.error("Email источника и получателя совпадают — копировать нечего.");
    process.exit(1);
  }

  const src = await findAgent(fromEmail, "источник");
  if (!src.agent) {
    console.error(`У ${fromEmail} нет агента — копировать нечего.`);
    process.exit(1);
  }
  const srcAgent = src.agent;

  const dst = await findAgent(toEmail, "получатель");

  const srcProfile = await prisma.businessProfile.findUnique({
    where: { agentId: srcAgent.id },
    select: { data: true }
  });
  const cards = await prisma.dialogueCard.findMany({
    where: { agentId: srcAgent.id },
    select: { sourceChatLabel: true, episodeIndex: true, card: true, excerpts: true },
    orderBy: { createdAt: "asc" }
  });
  const styleAnalysis = await prisma.styleAnalysis.findUnique({
    where: { agentId: srcAgent.id },
    select: { status: true, stage: true, ownerName: true, totalEpisodes: true, processedEpisodes: true }
  });
  const exchangeRows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "StyleExchange" WHERE "agentId" = ${srcAgent.id}
  `.catch(() => [] as { count: bigint }[]);
  const exchangeCount = Number(exchangeRows[0]?.count ?? 0);

  console.log(`Источник:   ${fromEmail} → агент ${srcAgent.id} «${srcAgent.name}» (${srcAgent.status})`);
  console.log(`Получатель: ${toEmail} → ${dst.agent ? `агент ${dst.agent.id} «${dst.agent.name}»` : "агента нет, будет создан"}`);
  console.log(
    `К переносу: профиль=${srcProfile ? "да" : "нет"}, карточек стиля=${cards.length}, ` +
      `обменов RAG=${exchangeCount}, история=${withHistory ? "да" : "нет"}` +
      (dry ? " [dry-run, без изменений]" : "")
  );
  if (dry) return;

  // 1. Целевой агент: создаём или зачищаем.
  let dstAgentId = dst.agent?.id;
  if (!dstAgentId) {
    const seedProfile = createInitialProfile();
    const created = await prisma.agent.create({
      data: {
        userId: dst.user.id,
        name: srcAgent.name,
        status: "draft",
        currentPrompt: buildFallbackPrompt(seedProfile),
        readyToFinalize: false,
        businessProfile: { create: { data: seedProfile } }
      },
      select: { id: true }
    });
    dstAgentId = created.id;
    console.log(`  → создан агент ${dstAgentId} для ${toEmail}.`);
  } else {
    await prisma.$transaction([
      prisma.builderMessage.deleteMany({ where: { agentId: dstAgentId } }),
      prisma.testMessage.deleteMany({ where: { agentId: dstAgentId } }),
      prisma.promptVersion.deleteMany({ where: { agentId: dstAgentId } }),
      prisma.dialogueCard.deleteMany({ where: { agentId: dstAgentId } }),
      prisma.styleAnalysis.deleteMany({ where: { agentId: dstAgentId } })
    ]);
    await prisma.$executeRaw`DELETE FROM "StyleExchange" WHERE "agentId" = ${dstAgentId}`.catch(
      () => undefined
    );
    console.log(`  → целевой агент ${dstAgentId} зачищен.`);
  }

  // 2. Карточка агента + профиль бизнеса.
  await prisma.agent.update({
    where: { id: dstAgentId },
    data: {
      name: srcAgent.name,
      status: srcAgent.status,
      currentPrompt: srcAgent.currentPrompt,
      readyToFinalize: srcAgent.readyToFinalize,
      carcass: srcAgent.carcass,
      botModel: srcAgent.botModel,
      botEnabled: srcAgent.botEnabled
    }
  });
  if (srcProfile) {
    const data = srcProfile.data as Prisma.InputJsonValue;
    await prisma.businessProfile.upsert({
      where: { agentId: dstAgentId },
      create: { agentId: dstAgentId, data },
      update: { data }
    });
  }
  console.log("  → промпт и профиль бизнеса скопированы.");

  // 3. Стиль владельца: карточки, RAG-обмены (вместе с эмбеддингами), сводка анализа.
  if (cards.length > 0) {
    await prisma.dialogueCard.createMany({
      data: cards.map((c) => ({
        agentId: dstAgentId,
        sourceChatLabel: c.sourceChatLabel,
        episodeIndex: c.episodeIndex,
        card: c.card as Prisma.InputJsonValue,
        excerpts: c.excerpts as Prisma.InputJsonValue
      }))
    });
  }
  const copiedExchanges = await prisma.$executeRaw`
    INSERT INTO "StyleExchange" ("id","agentId","situation","clientText","ownerText","embedding")
    SELECT gen_random_uuid()::text, ${dstAgentId}, "situation", "clientText", "ownerText", "embedding"
    FROM "StyleExchange" WHERE "agentId" = ${srcAgent.id}
  `.catch((err: unknown) => {
    console.warn(`  ! обмены RAG не скопированы (${String(err)}) — стиль будет работать без RAG.`);
    return 0;
  });
  if (styleAnalysis) {
    await prisma.styleAnalysis.create({
      data: { agentId: dstAgentId, ...styleAnalysis, episodes: Prisma.JsonNull }
    });
  }
  if (cards.length || copiedExchanges) {
    console.log(`  → стиль владельца: карточек ${cards.length}, обменов RAG ${copiedExchanges}.`);
  }

  // 4. Опционально — история конструктора/теста и версии промпта.
  if (withHistory) {
    const builder = await prisma.builderMessage.findMany({
      where: { agentId: srcAgent.id },
      orderBy: { createdAt: "asc" }
    });
    const test = await prisma.testMessage.findMany({
      where: { agentId: srcAgent.id },
      orderBy: { createdAt: "asc" }
    });
    const versions = await prisma.promptVersion.findMany({
      where: { agentId: srcAgent.id },
      orderBy: { createdAt: "asc" }
    });
    if (builder.length) {
      await prisma.builderMessage.createMany({
        data: builder.map((m) => ({
          agentId: dstAgentId,
          role: m.role,
          content: m.content,
          parts: m.parts as Prisma.InputJsonValue,
          createdAt: m.createdAt
        }))
      });
    }
    if (test.length) {
      await prisma.testMessage.createMany({
        data: test.map((m) => ({
          agentId: dstAgentId,
          role: m.role,
          content: m.content,
          parts: m.parts as Prisma.InputJsonValue,
          createdAt: m.createdAt
        }))
      });
    }
    if (versions.length) {
      // parentId не переносим: цепочка версий указывала бы на чужого агента.
      await prisma.promptVersion.createMany({
        data: versions.map((v) => ({
          agentId: dstAgentId,
          content: v.content,
          charCount: v.charCount,
          source: v.source,
          createdBy: v.createdBy,
          correctionType: v.correctionType,
          sectionEdited: v.sectionEdited,
          metadata: v.metadata as Prisma.InputJsonValue,
          createdAt: v.createdAt
        }))
      });
    }
    console.log(
      `  → история: конструктор ${builder.length}, тест ${test.length}, версий промпта ${versions.length}.`
    );
  }

  console.log(
    `Готово. Бот скопирован на ${toEmail}. WhatsApp-номер и диалоги не тронуты — ` +
      "подключите номер целевого аккаунта отдельно."
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
