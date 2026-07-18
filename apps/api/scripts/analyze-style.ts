/**
 * MVP-прогон фичи «бот в стиле владельца» из CLI (этап 3 плана — gate перед
 * продуктовой обвязкой). Парсит папку с экспортами диалогов, гоняет оба прохода
 * анализа и вживляет стиль в профиль агента.
 *
 * Запуск:
 *   pnpm --filter @jazu/api exec tsx --env-file=../../.env scripts/analyze-style.ts \
 *     <email> <папка_с_файлами> "<как_владелец_подписан_в_чатах>" [--limit=200] [--dry]
 *
 * Форматы файлов в папке:
 *   - *.txt  — «Экспорт чата» WhatsApp (нужно имя владельца для определения его реплик);
 *   - *.json — дамп wtsexporter (владелец определяется по from_me, имя не нужно).
 *
 * --dry — только распарсить и отранжировать, без LLM-вызовов и записи в БД
 *         (проверить, что файлы читаются и владелец определяется верно).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { prisma } from "@jazu/db";
import { parseDialogueSource, rankEpisodes, type DialogueEpisode } from "@jazu/ai";
import { runStyleAnalysis, buildLlmTelemetry } from "@jazu/wa-pipeline";

function parseArgs() {
  const positional: string[] = [];
  let limit = 300;
  let dry = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry") dry = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) limit = n;
    } else positional.push(arg);
  }
  return { email: positional[0], dir: positional[1], ownerName: positional[2], limit, dry };
}

async function main() {
  const { email, dir, ownerName, limit, dry } = parseArgs();
  if (!email || !dir) {
    console.error(
      'Использование: tsx scripts/analyze-style.ts <email> <папка> "<имя владельца в чатах>" [--limit=200] [--dry]'
    );
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), deletedAt: null },
    select: { id: true, agents: { select: { id: true, name: true }, orderBy: { createdAt: "asc" }, take: 1 } }
  });
  if (!user || user.agents.length === 0) {
    console.error(`Пользователь ${email} или его агент не найдены.`);
    process.exit(1);
  }
  const agent = user.agents[0]!;
  console.log(`Агент ${agent.id} «${agent.name}», владелец в чатах: ${ownerName ?? "(не задан — только JSON)"}`);

  // Читаем и парсим все файлы папки.
  const entries = await readdir(dir);
  const files = entries.filter((f) => [".txt", ".json"].includes(extname(f).toLowerCase()));
  if (files.length === 0) {
    console.error(`В папке ${dir} нет .txt/.json файлов.`);
    process.exit(1);
  }

  const episodes: DialogueEpisode[] = [];
  for (const file of files) {
    const content = await readFile(join(dir, file), "utf8");
    const parsed = parseDialogueSource(content, {
      filename: file,
      chatLabel: basename(file),
      ...(ownerName ? { ownerName } : {})
    });
    episodes.push(...parsed);
    console.log(`  ${file}: ${parsed.length} эпизод(ов)`);
  }
  console.log(`Всего эпизодов: ${episodes.length}`);

  if (dry) {
    const ranked = rankEpisodes(episodes, { limit });
    console.log(`После ранжирования отобрано ${ranked.length} (limit=${limit}).`);
    console.log("Топ-3 по содержательности:");
    for (const { episode, score } of ranked.slice(0, 3)) {
      console.log(`  [${score.toFixed(1)}] ${episode.chatLabel} #${episode.episodeIndex}, реплик: ${episode.turns.length}`);
      for (const turn of episode.turns.slice(0, 4)) {
        console.log(`      ${turn.role === "owner" ? "Владелец" : "Клиент"}: ${turn.text.slice(0, 80)}`);
      }
    }
    console.log("[dry-run] LLM не вызывался, БД не менялась.");
    return;
  }

  const telemetry = buildLlmTelemetry({ prisma, route: "style-analyze-cli", userId: user.id, agentId: agent.id });
  const result = await runStyleAnalysis({
    prisma,
    agentId: agent.id,
    episodes,
    ...(ownerName ? { ownerName } : {}),
    telemetry,
    rankLimit: limit,
    onProgress: (p) => {
      if (p.stage === "analyzing" && p.done !== undefined) {
        process.stdout.write(`\r  проход 1: ${p.done}/${p.total}   `);
      } else {
        process.stdout.write(`\r  этап: ${p.stage}                   `);
      }
    }
  });
  process.stdout.write("\n");

  console.log(`Готово. Эпизодов: ${result.totalEpisodes}, в анализ: ${result.rankedEpisodes}, карточек: ${result.cardsCreated}.`);
  if (result.artifacts) {
    console.log("\n=== ПАСПОРТ СТИЛЯ (превью) ===");
    console.log(result.artifacts.styleGuide.slice(0, 800));
    console.log(`\n=== ПЛЕЙБУК (превью) ===`);
    console.log(result.artifacts.playbook.slice(0, 500));
    console.log(`\nfew-shot примеров: ${result.artifacts.fewShot.length}`);
  } else {
    console.log("Стиль не собран (карточек недостаточно или LLM недоступна).");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
