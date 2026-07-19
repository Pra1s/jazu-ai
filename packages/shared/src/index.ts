import { z } from "zod";
// Без .js — Next/Turbopack при сборке web не мапит .js → .ts в workspace-пакете.
import { BOT_MODELS, CARCASSES } from "./botContract";

export * from "./botContract";

export const actionButtonSchema = z.object({
  type: z.enum(["switch_to_test", "open_whatsapp", "start_over", "custom"]),
  label: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional()
});

export const businessProfileSchema = z.object({
  businessName: z.string().optional(),
  niche: z.string().optional(),
  description: z.string().optional(),
  offerings: z.array(z.string()).default([]),
  // Конкретный перечень услуг/товаров бота (v2.2). Обязателен для create-гейта
  // вместе с geography и hours. Живёт внутри BusinessProfile.data — без колонки.
  servicesList: z.array(z.string()).default([]),
  targetAudience: z.string().optional(),
  geography: z.string().optional(),
  languages: z.array(z.string()).default(["ru"]),
  hours: z.string().optional(),
  pricingPolicy: z.string().optional(),
  bookingFlow: z.string().optional(),
  leadGoal: z.string().optional(),
  handoffRules: z.string().optional(),
  tone: z.string().optional(),
  phonePolicy: z.string().optional(),
  addressPolicy: z.string().optional(),
  faq: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
  notAllowed: z.array(z.string()).default([]),
  channels: z.array(z.string()).default(["whatsapp"]),
  integrations: z.array(z.string()).default([]),
  emergencyCases: z.array(z.string()).default([]),
  // Роль бота (v2.2) — определяет цель и тон. Денормализуется на Agent.botModel
  // для быстрого чтения в рантайме, но истина профиля хранится здесь.
  botModel: z.enum(BOT_MODELS).optional(),
  // Механика воронки. Истина — Agent.carcass; в схеме нужна, т.к. v3-envelope
  // читает profile.carcass (значение подмешивается из Agent на вызове рантайма).
  carcass: z.enum(CARCASSES).optional(),
  notes: z.string().optional(),
  // Фича «бот в стиле владельца» (результат анализа диалогов). Всё опционально:
  // без стиля рантайм работает бит-в-бит как раньше (см. buildRuntimeEnvelope).
  // styleGuide — паспорт стиля (как писать), stylePlaybook — паттерны отработки
  // ситуаций, styleFewShot — отобранные примеры «Клиент/Владелец».
  styleGuide: z.string().optional(),
  stylePlaybook: z.string().optional(),
  styleFewShot: z.array(z.string()).default([]),
  // Ответ несколькими сообщениями (как живой человек). replySplitEnabled —
  // разрешить дробление; replyMaxMessages — потолок пузырей на один ответ.
  replySplitEnabled: z.boolean().default(true),
  replyMaxMessages: z.number().int().min(1).max(6).default(4),
  // Дожим клиента (follow-up), если он замолчал. Всё опционально: без включения
  // рантайм работает как раньше. followupSteps — серия шагов (задержка от якоря +
  // опц. текст пресета); followupRepeat* — «повторять хвостом» каждые N минут.
  followupEnabled: z.boolean().default(false),
  followupAnchor: z.enum(["last_bot", "last_client"]).default("last_bot"),
  followupSteps: z
    .array(
      z.object({
        delayMinutes: z.number().int().min(1).max(60 * 24 * 30),
        text: z.string().max(2000).optional()
      })
    )
    .max(10)
    .default([{ delayMinutes: 120 }, { delayMinutes: 1440 }, { delayMinutes: 2880 }]),
  followupRepeatEveryMinutes: z.number().int().min(5).max(60 * 24 * 30).optional(),
  followupRepeatMax: z.number().int().min(0).max(20).optional(),
  followupTextMode: z.enum(["auto", "preset"]).default("auto"),
  followupQuietStart: z.number().int().min(0).max(23).default(22),
  followupQuietEnd: z.number().int().min(0).max(23).default(9),
  followupTimezone: z.string().default("Asia/Almaty")
});

export type BusinessProfile = z.infer<typeof businessProfileSchema>;
export type ActionButton = z.infer<typeof actionButtonSchema>;

export const promptCardSchema = z.object({
  kind: z.enum(["update", "edits", "correction"]),
  changeKind: z.enum(["create", "edit", "correction"]).optional(),
  prompt: z.string(),
  addedLines: z.array(z.string()).default([]),
  removedLines: z.array(z.string()).default([]),
  changeSummary: z.string().optional(),
  correctionType: z.string().optional(),
  sectionEdited: z.string().optional(),
  charCount: z.number().int().nonnegative(),
  editsCount: z.number().int().nonnegative()
});

export type PromptCard = z.infer<typeof promptCardSchema>;

export const messagePartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  action_button: actionButtonSchema.optional(),
  prompt_card: promptCardSchema.optional(),
  stale: z.boolean().optional(),
  // Голосовое сообщение пользователя: сырой base64 без префикса data: и MIME.
  // В ленте рендерится как аудио-плеер; транскрипт хранится в content/text.
  audio_base64: z.string().optional(),
  audio_mime: z.string().optional()
});

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  parts: z.array(messagePartSchema).default([]),
  createdAt: z.string().optional()
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const leadSummarySchema = z.object({
  businessName: z.string().optional(),
  niche: z.string().optional(),
  summary: z.string(),
  status: z.enum(["new", "seen", "done"]).default("new"),
  fields: z.record(z.string(), z.unknown()).default({})
});

export type LeadSummary = z.infer<typeof leadSummarySchema>;

export const onboardingStepSchema = z.enum([
  "describe_business",
  "switch_to_test",
  "write_client_message",
  "correct_reply",
  "connect_whatsapp",
  "done"
]);

export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

export const defaultOnboardingSteps: OnboardingStep[] = [
  "describe_business",
  "switch_to_test",
  "write_client_message",
  "correct_reply",
  "connect_whatsapp",
  "done"
];

export function clampQuestions(questions: string[], max = 3): string[] {
  return questions.slice(0, max);
}

export function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

export function asJson<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}
