import type { Job, StyleAnalyzeJob } from "@jazu/queue";
import { runStyleAnalysis, buildLlmTelemetry } from "@jazu/wa-pipeline";
import { prisma, Prisma } from "@jazu/db";
import type { DialogueEpisode } from "@jazu/ai";
import { logger } from "../logger.js";

/**
 * Обработчик очереди style:analyze (фича «бот в стиле владельца»).
 *
 * Долгий (сотни LLM-вызовов): гоняет оба прохода анализа над эпизодами, которые
 * роут /agent/style-dialogues заранее распарсил и сохранил в StyleAnalysis.episodes.
 * Прогресс пишем в ту же строку (фронт поллит GET /agent/style-status). По завершении
 * стиль вмерджен в BusinessProfile.data и проиндексирован в RAG (внутри runStyleAnalysis).
 *
 * attempts=1 на очереди: повторять сотни вызовов при частичном сбое дорого; при
 * ошибке помечаем статус error, владелец перезапускает загрузкой заново.
 */
export async function handleStyleAnalyze(job: Job<StyleAnalyzeJob>): Promise<void> {
  const { agentId, clearHistoryOnSuccess, append } = job.data;

  const row = await prisma.styleAnalysis.findUnique({ where: { agentId } });
  if (!row) {
    logger.warn({ agentId, jobId: job.id }, "style-analyze: no StyleAnalysis row, skipping");
    return;
  }
  const episodes = (row.episodes as DialogueEpisode[] | null) ?? [];
  if (episodes.length === 0) {
    await prisma.styleAnalysis.update({
      where: { agentId },
      data: { status: "error", error: "нет эпизодов для анализа", episodes: Prisma.DbNull }
    });
    return;
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { userId: true } });
  const telemetry = buildLlmTelemetry({
    prisma,
    route: "style-analyze",
    userId: agent?.userId ?? null,
    agentId
  });

  await prisma.styleAnalysis.update({
    where: { agentId },
    data: { status: "analyzing", stage: "ranking", error: null }
  });

  try {
    const result = await runStyleAnalysis({
      prisma,
      agentId,
      episodes,
      ...(row.ownerName ? { ownerName: row.ownerName } : {}),
      ...(append ? { mode: "append" as const } : {}),
      telemetry,
      onProgress: async (p) => {
        const status =
          p.stage === "aggregating" ? "aggregating" : p.stage === "done" ? "done" : "analyzing";
        await prisma.styleAnalysis.update({
          where: { agentId },
          data: {
            status,
            stage: p.stage,
            ...(p.done !== undefined ? { processedEpisodes: p.done } : {}),
            ...(p.total !== undefined ? { totalEpisodes: p.total } : {})
          }
        });
      }
    });

    // nothingNew (append): все присланные диалоги уже разобраны раньше — стиль
    // остался прежним, это штатный исход, а не ошибка.
    const ok = Boolean(result.artifacts) || result.nothingNew === true;
    await prisma.styleAnalysis.update({
      where: { agentId },
      data: {
        status: ok ? "done" : "error",
        stage: "done",
        error: ok ? null : "не удалось собрать стиль (мало карточек)",
        // Освобождаем буфер эпизодов — сырьё после анализа не храним.
        episodes: Prisma.DbNull
      }
    });
    // Буфер личной переписки (history-источник) чистим ТОЛЬКО после успешного
    // прогона — до этого он единственная копия ввода (переприслать её нельзя).
    if (clearHistoryOnSuccess && ok) {
      await prisma.waHistoryChat.deleteMany({ where: { agentId } });
    }
    logger.info(
      {
        agentId,
        jobId: job.id,
        cards: result.cardsCreated,
        ranked: result.rankedEpisodes,
        mode: append ? "append" : "replace",
        nothingNew: result.nothingNew ?? false
      },
      "style-analyze completed"
    );
  } catch (err) {
    await prisma.styleAnalysis.update({
      where: { agentId },
      data: {
        status: "error",
        error: err instanceof Error ? err.message.slice(0, 500) : "unknown",
        episodes: Prisma.DbNull
      }
    });
    throw err;
  }
}
