/**
 * Снять с чата метку «pre-connection» — чтобы бот начал ему отвечать.
 *
 * Зачем: контакт, который писал владельцу ДО подключения WhatsApp, помечен как
 * чат, который бот не ведёт (см. isPreConnectionChat в @jazu/wa-pipeline).
 * Метка складывается из двух источников:
 *   1) строка в WaPreConnectionChat (снимок history-sync при привязке номера);
 *   2) Conversation.createdAt раньше отсечки WaConnection.botRespondsSince.
 * Скрипт снимает оба: удаляет строку снимка и, если надо, двигает createdAt
 * диалога на «сейчас». Сама отсечка botRespondsSince не трогается — остальные
 * старые чаты остаются заблокированными.
 *
 * Запуск:
 *   pnpm --filter @jazu/api unblock-wa-chat <chat> [--agent=<agentId|email>] [--dry]
 *
 * <chat> — любое из:
 *   - waChatId целиком: 77001234567@s.whatsapp.net, 277657472258270@lid
 *   - только цифры номера: 77001234567 (найдём по waChatId и customerPhone)
 *   - id диалога (Conversation.id)
 *
 * --agent нужен, только если один и тот же номер нашёлся у нескольких агентов.
 * --dry — показать, что будет сделано, ничего не меняя.
 *
 * Идемпотентен: повторный запуск ничего не меняет.
 */
import { prisma } from "@jazu/db";

type Target = {
  agentId: string;
  agentName: string | null;
  ownerEmail: string | null;
  waChatId: string;
  conversationId: string | null;
  conversationCreatedAt: Date | null;
  customerName: string | null;
  customerPhone: string | null;
  hasPreConnectionRow: boolean;
  botRespondsSince: Date | null;
  botEnabled: boolean;
};

function parseArgs() {
  const rest = process.argv.slice(2);
  const chat = rest.find((a) => !a.startsWith("--"))?.trim();
  const agentArg = rest.find((a) => a.startsWith("--agent="))?.slice("--agent=".length).trim() || null;
  const dry = rest.includes("--dry");
  return { chat, agentArg, dry };
}

/** Кандидаты waChatId + возможный Conversation.id по свободной строке. */
function chatCandidates(raw: string): { jids: string[]; digits: string | null; maybeId: string } {
  if (raw.includes("@")) {
    return { jids: [raw], digits: null, maybeId: raw };
  }
  const digits = /^\d{7,20}$/.test(raw) ? raw : null;
  const jids = digits ? [`${digits}@s.whatsapp.net`, `${digits}@lid`, `${digits}@c.us`] : [];
  return { jids, digits, maybeId: raw };
}

async function findTargets(raw: string, agentArg: string | null): Promise<Target[]> {
  const { jids, digits, maybeId } = chatCandidates(raw);

  // Агент-фильтр: id напрямую либо все агенты пользователя с таким email.
  let agentIds: string[] | null = null;
  if (agentArg) {
    const byId = await prisma.agent.findUnique({ where: { id: agentArg }, select: { id: true } });
    if (byId) {
      agentIds = [byId.id];
    } else {
      const agents = await prisma.agent.findMany({
        where: { user: { email: agentArg.toLowerCase(), deletedAt: null } },
        select: { id: true }
      });
      agentIds = agents.map((a) => a.id);
      if (agentIds.length === 0) {
        console.error(`Агент не найден: ${agentArg} (ни по id, ни по email владельца).`);
        process.exit(1);
      }
    }
  }
  const agentFilter = agentIds ? { agentId: { in: agentIds } } : {};

  const conversations = await prisma.conversation.findMany({
    where: {
      ...agentFilter,
      OR: [
        { id: maybeId },
        ...(jids.length ? [{ waChatId: { in: jids } }] : []),
        ...(digits ? [{ customerPhone: digits }] : [])
      ]
    },
    select: {
      id: true,
      agentId: true,
      waChatId: true,
      createdAt: true,
      customerName: true,
      customerPhone: true
    }
  });

  // Метка могла остаться и без диалога (клиент писал до подключения, бот молчал,
  // Conversation ещё не заведён) — ищем строки снимка отдельно.
  //
  // ВАЖНО: ищем и по waChatId НАЙДЕННЫХ диалогов, а не только по кандидатам из
  // аргумента. Когда чат найден по номеру (customerPhone), его реальный
  // waChatId — это @lid-идентификатор WhatsApp (`126702155989171@lid`), который
  // из цифр номера не выводится. Без этого снимок молча не находился, скрипт
  // рапортовал «блокировки нет», а бот продолжал игнорировать чат.
  const lookupJids = [...new Set([...jids, ...conversations.map((c) => c.waChatId), maybeId])];
  const preRows = await prisma.waPreConnectionChat.findMany({
    where: { ...agentFilter, waChatId: { in: lookupJids } },
    select: { agentId: true, waChatId: true }
  });

  const keys = new Map<string, { agentId: string; waChatId: string }>();
  for (const c of conversations) keys.set(`${c.agentId}|${c.waChatId}`, { agentId: c.agentId, waChatId: c.waChatId });
  for (const p of preRows) keys.set(`${p.agentId}|${p.waChatId}`, { agentId: p.agentId, waChatId: p.waChatId });
  if (keys.size === 0) return [];

  const agents = await prisma.agent.findMany({
    where: { id: { in: [...new Set([...keys.values()].map((k) => k.agentId))] } },
    select: {
      id: true,
      name: true,
      botEnabled: true,
      user: { select: { email: true } },
      // agentId у WaConnection @unique — связь-массив, но строк максимум одна.
      waConnections: { select: { botRespondsSince: true }, take: 1 }
    }
  });
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const preSet = new Set(preRows.map((p) => `${p.agentId}|${p.waChatId}`));
  const convByKey = new Map(conversations.map((c) => [`${c.agentId}|${c.waChatId}`, c]));

  return [...keys.entries()].map(([key, { agentId, waChatId }]) => {
    const agent = agentById.get(agentId);
    const conv = convByKey.get(key) ?? null;
    return {
      agentId,
      agentName: agent?.name ?? null,
      ownerEmail: agent?.user?.email ?? null,
      waChatId,
      conversationId: conv?.id ?? null,
      conversationCreatedAt: conv?.createdAt ?? null,
      customerName: conv?.customerName ?? null,
      customerPhone: conv?.customerPhone ?? null,
      hasPreConnectionRow: preSet.has(key),
      botRespondsSince: agent?.waConnections[0]?.botRespondsSince ?? null,
      botEnabled: agent?.botEnabled ?? false
    } satisfies Target;
  });
}

async function main() {
  const { chat, agentArg, dry } = parseArgs();
  if (!chat) {
    console.error("Использование: tsx scripts/unblock-wa-chat.ts <chatId|номер|conversationId> [--agent=<agentId|email>] [--dry]");
    process.exit(1);
  }

  const targets = await findTargets(chat, agentArg);
  if (targets.length === 0) {
    console.error(`Ничего не найдено по «${chat}». Проверь waChatId (он виден в кабинете/логах) или добавь --agent=.`);
    process.exit(1);
  }
  if (targets.length > 1) {
    console.error(`Найдено ${targets.length} совпадений у разных агентов — уточни --agent=<agentId|email>:`);
    for (const t of targets) {
      console.error(`  agent=${t.agentId} (${t.ownerEmail ?? "?"}) chat=${t.waChatId} conv=${t.conversationId ?? "—"}`);
    }
    process.exit(1);
  }

  const t = targets[0]!;
  console.log("Чат:");
  console.log(`  agent          : ${t.agentId} (${t.agentName ?? "без имени"}, владелец ${t.ownerEmail ?? "?"})`);
  console.log(`  waChatId       : ${t.waChatId}`);
  console.log(`  conversation   : ${t.conversationId ?? "— (ещё не заведён)"}`);
  console.log(`  клиент         : ${t.customerName ?? "?"} ${t.customerPhone ?? ""}`.trimEnd());
  console.log(`  botEnabled     : ${t.botEnabled}`);
  console.log(`  botRespondsSince: ${t.botRespondsSince?.toISOString() ?? "— (отсечки нет)"}`);
  console.log(`  снимок pre-connection : ${t.hasPreConnectionRow ? "ЕСТЬ (блокирует)" : "нет"}`);

  const staleConversation =
    t.botRespondsSince !== null &&
    t.conversationCreatedAt !== null &&
    t.conversationCreatedAt < t.botRespondsSince;
  console.log(
    `  createdAt диалога     : ${t.conversationCreatedAt?.toISOString() ?? "—"}` +
      (staleConversation ? " — РАНЬШЕ отсечки (блокирует)" : "")
  );

  if (!t.hasPreConnectionRow && !staleConversation) {
    console.log("\nБлокировки нет — бот уже может отвечать этому чату. Ничего не меняю.");
    if (!t.botEnabled) console.log("Внимание: у агента botEnabled=false — бот выключен целиком.");
    return;
  }

  if (dry) {
    console.log("\n[dry] Было бы сделано:");
    if (t.hasPreConnectionRow) console.log("  - удалить строку WaPreConnectionChat");
    if (staleConversation) console.log("  - сдвинуть Conversation.createdAt на текущий момент");
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (t.hasPreConnectionRow) {
      await tx.waPreConnectionChat.deleteMany({ where: { agentId: t.agentId, waChatId: t.waChatId } });
      console.log("\n✓ строка WaPreConnectionChat удалена");
    }
    if (staleConversation && t.conversationId) {
      await tx.conversation.update({ where: { id: t.conversationId }, data: { createdAt: new Date() } });
      console.log("✓ Conversation.createdAt сдвинут на сейчас");
    }
  });

  console.log("\nГотово: бот ответит на следующее входящее из этого чата.");
  if (!t.botEnabled) console.log("Внимание: у агента botEnabled=false — бот выключен целиком, включи его в кабинете.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
