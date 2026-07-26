// Дожим клиента (follow-up): если клиент замолчал после ответа бота, через
// настроенные интервалы шлём мягкое напоминание (пресет или авто LLM+RAG в стиле
// владельца) и планируем следующий шаг серии. Планировщик по образцу
// flush-scheduler: одна отложенная задача на чат (jobId = followup:<agentId>:<chatId>),
// ставится при ответе бота (attempt 0), отменяется при входящем клиента.

import { createInitialProfile, generateFollowupText, splitBotReply } from "@jazu/ai";
import { prisma as defaultPrisma, type Prisma } from "@jazu/db";
import { businessProfileSchema, type BusinessProfile } from "@jazu/shared";
import {
  getFollowupQueue,
  getOutboundQueue,
  OUTBOUND_JOB_OPTIONS,
  type WaOutboundJob
} from "@jazu/queue";
import { buildLlmTelemetry } from "./llm-telemetry.js";
import { retrieveStyleExamples } from "./style-rag.js";

type PrismaClient = typeof defaultPrisma;

/** Минимальная задержка задачи (защита от 0/отрицательных при anchor-коррекции). */
const MIN_DELAY_MS = 60_000;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function followupJobId(agentId: string, chatId: string): string {
  return `followup:${agentId}:${chatId}`;
}

type FollowupConfig = {
  enabled: boolean;
  anchor: "last_bot" | "last_client";
  steps: BusinessProfile["followupSteps"];
  repeatEveryMinutes: number | null;
  repeatMax: number;
  textMode: "auto" | "preset";
  quietStart: number;
  quietEnd: number;
  timezone: string;
  splitEnabled: boolean;
  maxMessages: number;
};

function normalizeFollowupConfig(profile: BusinessProfile): FollowupConfig {
  const steps = (profile.followupSteps ?? []).filter((s) => s && s.delayMinutes > 0);
  const repeatEvery = profile.followupRepeatEveryMinutes ?? null;
  return {
    enabled: profile.followupEnabled === true && steps.length > 0,
    anchor: profile.followupAnchor ?? "last_bot",
    steps,
    repeatEveryMinutes: repeatEvery,
    repeatMax: repeatEvery ? profile.followupRepeatMax ?? 3 : 0,
    textMode: profile.followupTextMode ?? "auto",
    quietStart: profile.followupQuietStart ?? 22,
    quietEnd: profile.followupQuietEnd ?? 9,
    timezone: profile.followupTimezone ?? "Asia/Almaty",
    splitEnabled: profile.replySplitEnabled !== false,
    maxMessages: profile.replyMaxMessages ?? 4
  };
}

/** Общее число попыток серии (явные шаги + repeat-хвост). */
function totalAttempts(config: FollowupConfig): number {
  return config.steps.length + config.repeatMax;
}

/** Задержка (минуты) ПЕРЕД отправкой попытки attempt: из шага или repeat-хвоста. */
function stepDelayMinutes(config: FollowupConfig, attempt: number): number | null {
  if (attempt < 0) return null;
  if (attempt < config.steps.length) return config.steps[attempt]!.delayMinutes;
  if (config.repeatEveryMinutes && attempt < totalAttempts(config)) return config.repeatEveryMinutes;
  return null;
}

/** Текст пресета для попытки (только у явных шагов; у repeat-хвоста нет). */
function stepPresetText(config: FollowupConfig, attempt: number): string | undefined {
  const t = attempt < config.steps.length ? config.steps[attempt]?.text : undefined;
  return t && t.trim().length > 0 ? t.trim() : undefined;
}

async function loadProfile(prisma: PrismaClient, agentId: string): Promise<BusinessProfile | null> {
  const profileRow = await prisma.businessProfile.findUnique({ where: { agentId } });
  if (!profileRow) return createInitialProfile();
  try {
    return businessProfileSchema.parse(profileRow.data);
  } catch {
    return null;
  }
}

/**
 * Ставит (или пересоздаёт) отложенную задачу дожима на попытку attempt. Для attempt 0
 * якорь — время последнего сообщения (бота/клиента по настройке); для последующих —
 * «сейчас» (только что отправили дожим). Ничего не делает, если дожим выключен или
 * серия исчерпана. Best-effort: ошибки не бросаем, чтобы не ломать основной поток.
 */
export async function scheduleFollowup(
  agentId: string,
  chatId: string,
  attempt: number,
  opts: { prisma?: PrismaClient; lastClientAtMs?: number } = {}
): Promise<void> {
  const prisma = opts.prisma ?? defaultPrisma;
  try {
    const profile = await loadProfile(prisma, agentId);
    if (!profile) return;
    const config = normalizeFollowupConfig(profile);
    if (!config.enabled) return;
    const delayMin = stepDelayMinutes(config, attempt);
    if (delayMin === null) return; // серия закончилась

    let delayMs = delayMin * 60_000;
    if (attempt === 0 && config.anchor === "last_client" && opts.lastClientAtMs) {
      delayMs = delayMs - (Date.now() - opts.lastClientAtMs);
    }
    if (delayMs < MIN_DELAY_MS) delayMs = MIN_DELAY_MS;

    const queue = getFollowupQueue();
    const jobId = followupJobId(agentId, chatId);
    // Сброс: убираем прежнюю отложенную задачу (новый ответ бота = серия с нуля).
    const existing = await queue.getJob(jobId);
    if (existing) await existing.remove().catch(() => undefined);
    await queue.add(
      "wa-followup",
      { agentId, chatId, attempt },
      { jobId, delay: delayMs, removeOnComplete: true }
    );
  } catch (err) {
    console.error("[followup] schedule skipped:", err instanceof Error ? err.message : err);
  }
}

/** Отменяет запланированный дожим (клиент ответил). Best-effort. */
export async function cancelFollowup(
  agentId: string,
  chatId: string,
  opts: { prisma?: PrismaClient } = {}
): Promise<void> {
  void opts;
  try {
    const job = await getFollowupQueue().getJob(followupJobId(agentId, chatId));
    if (job) await job.remove().catch(() => undefined);
  } catch (err) {
    console.error("[followup] cancel skipped:", err instanceof Error ? err.message : err);
  }
}

function tzHourMinute(timezone: string, date = new Date()): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return { hour: Number.isFinite(hour) ? hour % 24 : 0, minute: Number.isFinite(minute) ? minute : 0 };
  } catch {
    return { hour: new Date().getHours(), minute: new Date().getMinutes() };
  }
}

function isQuietHour(config: FollowupConfig, hour: number): boolean {
  if (config.quietStart === config.quietEnd) return false; // окно нулевое — тихих часов нет
  return config.quietStart < config.quietEnd
    ? hour >= config.quietStart && hour < config.quietEnd
    : hour >= config.quietStart || hour < config.quietEnd; // ночное окно через полночь
}

/** Задержка (мс) до конца тихих часов (следующий час quietEnd в таймзоне). */
function delayUntilQuietEnd(config: FollowupConfig): number {
  const { hour, minute } = tzHourMinute(config.timezone);
  let hoursUntil = (config.quietEnd - hour + 24) % 24;
  if (hoursUntil === 0) hoursUntil = 24;
  const delay = hoursUntil * 3_600_000 - minute * 60_000;
  return Math.max(MIN_DELAY_MS, delay);
}

export type FollowupRunResult =
  | "sent"
  | "skipped_disabled"
  | "skipped_paused"
  | "skipped_status"
  | "skipped_client_replied"
  | "skipped_no_steps"
  | "skipped_no_text"
  | "deferred_quiet"
  | "agent_not_found"
  | "nothing";

/**
 * Выполняет один шаг дожима: гарды → текст (пресет/авто+RAG) → отправка → планирование
 * следующего шага. Вызывается воркером очереди wa-followup.
 */
export async function runFollowup(
  agentId: string,
  chatId: string,
  attempt: number,
  options: { prisma?: PrismaClient } = {}
): Promise<FollowupRunResult> {
  const prisma = options.prisma ?? defaultPrisma;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { businessProfile: true }
  });
  if (!agent) return "agent_not_found";
  if (!agent.botEnabled) return "skipped_paused";

  const profile = agent.businessProfile
    ? businessProfileSchema.parse(agent.businessProfile.data)
    : createInitialProfile();
  const config = normalizeFollowupConfig(profile);
  if (!config.enabled) return "skipped_disabled";

  // Попытка вне серии (исчерпана) — стоп.
  const delayMinForThis = stepDelayMinutes(config, attempt);
  if (delayMinForThis === null) return "skipped_no_steps";

  const conversation = await prisma.conversation.findUnique({
    where: { agentId_waChatId: { agentId, waChatId: chatId } }
  });
  if (!conversation) return "nothing";
  if (conversation.status !== "open") return "skipped_status";

  // Клиент ответил после последнего сообщения бота — дожимать не нужно.
  const lastMessage = await prisma.waMessage.findFirst({
    where: { conversationId: conversation.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  if (!lastMessage || lastMessage.direction === "in") return "skipped_client_replied";

  // Тихие часы — не будим клиента ночью, переносим ЭТУ же попытку на утро.
  const { hour } = tzHourMinute(config.timezone);
  if (isQuietHour(config, hour)) {
    await getFollowupQueue()
      .add("wa-followup", { agentId, chatId, attempt }, {
        jobId: followupJobId(agentId, chatId),
        delay: delayUntilQuietEnd(config),
        removeOnComplete: true
      })
      .catch(() => undefined);
    return "deferred_quiet";
  }

  // Текст дожима: пресет (если задан для этого шага) или авто (LLM+RAG).
  const preset = stepPresetText(config, attempt);
  let text = config.textMode === "preset" && preset ? preset : "";
  if (!text) {
    const history = await prisma.waMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20
    });
    history.reverse();
    const lastClientText =
      [...history].reverse().find((m) => m.direction === "in")?.body ?? conversation.detectedNeed ?? "";
    const retrievedExamples = profile.styleGuide
      ? await retrieveStyleExamples(prisma, agentId, lastClientText, 5)
      : [];
    const activePromptVersion = await prisma.promptVersion.findFirst({
      where: { agentId },
      orderBy: { createdAt: "desc" }
    });
    const systemOverride = activePromptVersion?.content || agent.currentPrompt || null;
    text = await generateFollowupText({
      profile: {
        ...profile,
        carcass: (agent.carcass ?? null) as BusinessProfile["carcass"],
        botModel: (agent.botModel ?? null) as BusinessProfile["botModel"]
      },
      businessPrompt: systemOverride,
      history: history.map((m) => ({
        role: m.direction === "out" ? ("assistant" as const) : ("user" as const),
        content: m.body
      })),
      detectedNeed: conversation.detectedNeed,
      detectedName: conversation.detectedName,
      retrievedExamples,
      attempt,
      telemetry: buildLlmTelemetry({
        prisma,
        route: "wa-followup",
        userId: agent.userId ?? null,
        agentId
      })
    });
    // Пресет как фолбэк, если авто не получилось.
    if (!text && preset) text = preset;
  }

  // Нет текста — не шлём пустоту, но двигаем серию дальше (следующий шаг).
  if (!text || text.trim().length === 0) {
    await scheduleFollowup(agentId, chatId, attempt + 1, { prisma });
    return "skipped_no_text";
  }

  const parts = splitBotReply(text, config.splitEnabled ? config.maxMessages : 1);
  if (parts.length === 0) {
    await scheduleFollowup(agentId, chatId, attempt + 1, { prisma });
    return "skipped_no_text";
  }
  const combined = parts.join("\n");

  // Персистим исходящий дожим (история + курсор становится «out» → входящее клиента
  // потом отменит серию), затем кладём в outbound на отправку через воркер.
  await prisma.waMessage.create({
    data: {
      conversationId: conversation.id,
      direction: "out",
      body: combined,
      parts: jsonInput(parts.map((t) => ({ type: "text", text: t })))
    }
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() }
  });

  const outbound: WaOutboundJob = {
    agentId,
    chatId,
    text: combined,
    ...(parts.length > 1 ? { texts: parts } : {}),
    humanize: true,
    inboundReceivedAtMs: Date.now(),
    targetReplyAtMs: Date.now() + 2_000 + Math.floor(Math.random() * 4_000),
    isFirstBotReply: false
  };
  await getOutboundQueue().add("wa-outbound", outbound, OUTBOUND_JOB_OPTIONS);

  // Планируем следующий шаг серии (если он есть).
  await scheduleFollowup(agentId, chatId, attempt + 1, { prisma });
  return "sent";
}
