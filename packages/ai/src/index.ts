import { businessProfileSchema, type ActionButton, type BusinessProfile } from "@jazu/shared";
import {
  completeStream,
  runJsonCallWithTelemetry,
  sanitizeAssistantText,
  type LlmTelemetryHooks,
  type StreamChunk
} from "./openai.js";
import {
  buildBuilderSystemPrompt,
  buildCorrectionSystemPrompt,
  buildPromptFromProfile,
  buildRuntimeEnvelope,
  buildRuntimePrompt,
  getNextQuestions,
  mergeProfile,
  summarizeLead,
  RUNTIME_FALLBACK
} from "./prompts.js";

export type PromptEventKind = "skip" | "create" | "edit";

export type Carcass = "booking" | "inspection" | "sales";

export type BotModel = "admin" | "consultant" | "support" | "qualifier" | "salesman";

export type BuilderTurn = {
  assistantText: string;
  profilePatch: Partial<BusinessProfile>;
  nextQuestions: string[];
  promptDraft?: string;
  promptEvent?: PromptEventKind;
  promptSummary?: string;
  carcass?: Carcass | null;
  botModel?: BotModel | null;
  actionButton?: ActionButton | undefined;
  readyToTest?: boolean;
  notes?: string[] | undefined;
};

export type RuntimeTurn = {
  reply: string;
  shouldHandoff: boolean;
  handoffType?: "hot_lead" | "complaint" | "out_of_scope" | "requested" | null;
  summary?: string;
  // Что бот понял про потребность клиента в этом ходе (буфер detectedNeed).
  extractedNeed?: string;
  // true ТОЛЬКО если клиент явно сменил запрос — триггер жёсткой перезаписи.
  needChanged?: boolean;
  actionButton?: ActionButton | undefined;
};

function normalizeStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractShortValue(text: string, maxLen = 120): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function heuristicPatch(userText: string, profile: BusinessProfile): Partial<BusinessProfile> {
  const text = userText.trim();
  const patch: Partial<BusinessProfile> = {};

  // businessName — only when explicit label is present
  if (!profile.businessName) {
    const m = text.match(/(?:меня зовут|называется|название|бренд|компания)\s*[:\-–]?\s*([А-ЯA-Za-zа-я0-9«»"']{2,60})/i);
    if (m?.[1]) {
      patch.businessName = m[1].replace(/[.!?]+$/, "").trim();
    }
  }

  // niche — only when text is the first message and niche is not yet set
  if (!profile.niche && !profile.description && text.length > 10 && text.length < 400) {
    patch.niche = extractShortValue(text, 120);
  }

  // description — only on the first descriptive message
  if (!profile.description && !profile.niche && text.length > 30 && text.length < 400) {
    patch.description = extractShortValue(text, 220);
  }

  // hours — only when explicit time range pattern found
  const hoursMatch = text.match(/\b(\d{1,2}[:.]?\d{0,2})\s*[-–—до]\s*(\d{1,2}[:.]?\d{0,2})\b/);
  if (!profile.hours && hoursMatch) {
    patch.hours = `${hoursMatch[1]}-${hoursMatch[2]}`;
  }

  // geography — only when explicit city/location keywords + short extract
  if (!profile.geography) {
    const geoMatch = text.match(/(?:в\s+)?(?:г\.|город|район|[А-Я][а-я]+ и [А-Я][а-я]+|Алматы|Астана|Москва|Питер|Ташкент|Алма-Ата)/i);
    if (geoMatch) {
      patch.geography = extractShortValue(text, 100);
    }
  }

  // languages — only when explicit language codes
  const languages = normalizeStrings(text.match(/\b(?:ru|рус(?:ский)?|каз(?:ахский)?|kz|en(?:g(?:lish)?)?)\b/gi));
  if (languages.length > 0 && profile.languages.length <= 1) {
    patch.languages = [...new Set(languages.map((l) => l.toLowerCase().slice(0, 2)))].filter(Boolean);
  }

  return patch;
}

function buildFallbackBuilderReply(profile: BusinessProfile, userText: string): BuilderTurn {
  const patch = heuristicPatch(userText, profile);
  const merged = mergeProfile(profile, patch);
  const nextQuestions = getNextQuestions(merged, 1);
  const readyToTest = nextQuestions.length === 0;
  const promptDraft = buildPromptFromProfile(merged);
  const actionButton = readyToTest
    ? {
        type: "switch_to_test" as const,
        label: "Протестировать"
      }
    : undefined;

  const assistantText = readyToTest
    ? [
        `Собрал основу для ${merged.businessName || "вашего бизнеса"}.`,
        "Я подготовил промпт и можно переходить в тест, чтобы проверить реальные ответы бота.",
        "Если хотите, я ещё могу усилить сценарий, добавить исключения или более жёсткие правила передачи человеку."
      ].join(" ")
    : [
        `Понял. Я уже зафиксировал: ${merged.businessName || merged.niche || "ваш бизнес"}${merged.geography ? `, ${merged.geography}` : ""}.`,
        nextQuestions.length > 0 ? nextQuestions[0] : "Продолжаю уточнять детали."
      ].join(" ");

  return {
    assistantText: sanitizeAssistantText(assistantText),
    profilePatch: patch,
    nextQuestions,
    promptDraft,
    promptEvent: "skip",
    ...(actionButton ? { actionButton } : {}),
    readyToTest
  };
}

export async function buildBuilderTurn(
  profile: BusinessProfile,
  userText: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  telemetry?: LlmTelemetryHooks
): Promise<BuilderTurn> {
  const fallback = buildFallbackBuilderReply(profile, userText);
  const nextProfile = mergeProfile(profile, fallback.profilePatch);

  try {
    const userTurns = history.filter((m) => m.role === "user").slice(-6);
    const assistantTurns = history.filter((m) => m.role === "assistant").slice(-3);

    const knownLines: string[] = [];
    if (nextProfile.businessName) knownLines.push(`- Название: ${nextProfile.businessName}`);
    if (nextProfile.niche) knownLines.push(`- Ниша: ${nextProfile.niche}`);
    if (nextProfile.description) knownLines.push(`- Описание: ${nextProfile.description}`);
    if (nextProfile.offerings.length) knownLines.push(`- Услуги/продукты: ${nextProfile.offerings.join("; ")}`);
    if (nextProfile.targetAudience) knownLines.push(`- Аудитория: ${nextProfile.targetAudience}`);
    if (nextProfile.geography) knownLines.push(`- География: ${nextProfile.geography}`);
    if (nextProfile.hours) knownLines.push(`- Часы: ${nextProfile.hours}`);
    if (nextProfile.pricingPolicy) knownLines.push(`- Цены: ${nextProfile.pricingPolicy}`);
    if (nextProfile.bookingFlow) knownLines.push(`- Сценарий заявки: ${nextProfile.bookingFlow}`);
    if (nextProfile.leadGoal) knownLines.push(`- Цель диалога: ${nextProfile.leadGoal}`);
    if (nextProfile.botModel) knownLines.push(`- Модель бота: ${nextProfile.botModel}`);
    if (nextProfile.carcass) knownLines.push(`- Каркас воронки: ${nextProfile.carcass}`);
    if (nextProfile.handoffRules) knownLines.push(`- Передача человеку: ${nextProfile.handoffRules}`);
    if (nextProfile.tone) knownLines.push(`- Тон: ${nextProfile.tone}`);

    const completionWrapper = await runJsonCallWithTelemetry<{
      assistantText?: string;
      profilePatch?: Partial<BusinessProfile>;
      nextQuestions?: string[];
      promptDraft?: string;
      promptEvent?: PromptEventKind;
      promptSummary?: string;
      carcass?: Carcass | null;
      botModel?: BotModel | null;
      readyToTest?: boolean;
      notes?: string[];
      actionButton?: ActionButton;
    }>({
      system: buildBuilderSystemPrompt(nextProfile),
      messages: [
        ...history.map((message) => ({
          role: message.role,
          content: message.content
        })),
        {
          role: "user",
          content: [
            `Последнее сообщение пользователя: """${userText}"""`,
            "",
            "## ПАМЯТЬ (это уже известно про бизнес — НЕ переспрашивай)",
            knownLines.length > 0 ? knownLines.join("\n") : "- (пока ничего не зафиксировано)",
            "",
            "## ПОСЛЕДНИЕ ОТВЕТЫ ПОЛЬЗОВАТЕЛЯ",
            userTurns.length > 0 ? userTurns.map((m, i) => `${i + 1}. "${m.content}"`).join("\n") : "(пусто)",
            "",
            "## ТВОИ ПОСЛЕДНИЕ ВОПРОСЫ",
            assistantTurns.length > 0 ? assistantTurns.map((m, i) => `${i + 1}. "${m.content}"`).join("\n") : "(пусто)",
            "",
            "## ПРАВИЛА ХОДА",
            "1. Прочитай ПАМЯТЬ — НИ В КОЕМ СЛУЧАЕ не задавай вопрос про поле, которое там уже есть.",
            "2. Если короткое последнее сообщение ('Алматы', 'не знаю', 'я же говорил', 'ок', '?') — пойми его в контексте ТВОЕГО последнего вопроса.",
            "   - Если это содержательный ответ на твой вопрос — положи его в profilePatch и иди дальше.",
            "   - Если 'не знаю'/'без разницы' — зафиксируй поле как пропущенное и иди к следующему.",
            "   - Если 'я же говорил'/'уже сказал' — НЕ переспрашивай тот же вопрос. Извинись одной фразой и перейди к следующему НЕпокрытому полю.",
            "   - Если '?' или непонятка — коротко объясни, что ты хотел узнать, и дай 2-3 примера ответа в **bold**.",
            "3. profilePatch — только то, что реально сказано в ЭТОМ сообщении. Не выдумывай.",
            "4. nextQuestions — максимум 1.",
            "5. Стиль ответа — живой, без шаблонов. НЕ начинай каждое сообщение со слова 'Принял'. Чередуй: 'Ок,', 'Понял,', 'Так,', 'Ага,', 'Хорошо,', или вообще без вводного слова.",
            "6. Подтверждение и вопрос соединяй одной фразой, а не через точку 'Принял X. Теперь Y'.",
            "",
            "## ЧЕК-ЛИСТ ВОПРОСА (проверь свой следующий вопрос перед ответом)",
            "- [ ] В вопросе есть 2-3 готовых варианта в **bold**, чтобы юзер мог ответить одним словом/тапом.",
            "- [ ] Я НЕ использовал слова: 'опишите', 'опиши', 'расскажите подробнее', 'в двух словах', 'как проходит процесс', 'как выглядит', 'перечислите', 'распишите'.",
            "- [ ] Варианты подобраны под уже известную нишу, а не абстрактные.",
            "- [ ] В вопросе один параметр (не два сразу).",
            "- [ ] Вопрос можно прочитать вслух за 3 секунды.",
            "Если хоть один пункт не выполнен — переформулируй.",
            "",
            "## КОНТЕКСТ ХОДА",
            `Пользователь сделал ${userTurns.length} содержательных ход(ов) с начала диалога.`,
            "Решение, нужна ли карточка с промптом на этом ходе, принимаешь ТЫ через поле promptEvent (skip/create/edit). См. секцию 'СОБЫТИЕ ПРОМПТА' в системной инструкции.",
            "",
            "Верни только валидный JSON."
          ].join("\n")
        }
      ],
      temperature: 0.4
    }, telemetry);

    if (completionWrapper.blocked) {
      // Дневной бюджет токенов исчерпан — отдаём fallback без LLM.
      return fallback;
    }
    const completion = completionWrapper.result;

    if (!completion) {
      return fallback;
    }

    const rawCompletionPatch = (completion.profilePatch ?? {}) as Record<string, unknown>;
    const arrayKeys = ["offerings", "servicesList", "faq", "examples", "notAllowed", "channels", "integrations", "emergencyCases", "languages"] as const;
    for (const key of arrayKeys) {
      const v = rawCompletionPatch[key];
      if (typeof v === "string") {
        rawCompletionPatch[key] = v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      } else if (v && !Array.isArray(v)) {
        rawCompletionPatch[key] = [];
      }
    }
    const stringKeys = ["businessName", "niche", "description", "targetAudience", "geography", "hours", "pricingPolicy", "bookingFlow", "leadGoal", "handoffRules", "tone", "phonePolicy", "addressPolicy", "notes"] as const;
    for (const key of stringKeys) {
      const v = rawCompletionPatch[key];
      if (v != null && typeof v !== "string") {
        if (Array.isArray(v)) {
          rawCompletionPatch[key] = v.filter((x) => typeof x === "string").join(", ");
        } else if (typeof v === "number" || typeof v === "boolean") {
          rawCompletionPatch[key] = String(v);
        } else {
          // Не пытаемся стрингифицировать произвольный объект — это даст
          // "[object Object]" и засрёт профиль. Пропускаем некорректное значение.
          rawCompletionPatch[key] = undefined;
        }
      }
    }
    const sanitizedCompletionPatch = rawCompletionPatch as Partial<BusinessProfile>;
    const mergedPatch = mergeProfile(nextProfile, sanitizedCompletionPatch);
    const promptDraft = completion.promptDraft || buildPromptFromProfile(mergedPatch);
    const nextQuestions = completion.nextQuestions && completion.nextQuestions.length > 0
      ? completion.nextQuestions.slice(0, 1)
      : getNextQuestions(mergedPatch, 1);
    const actionButton = completion.actionButton ||
      (nextQuestions.length === 0
        ? {
            type: "switch_to_test" as const,
            label: "Протестировать"
          }
        : undefined);

    const combinedPatch: Partial<BusinessProfile> = {
      ...fallback.profilePatch,
      ...sanitizedCompletionPatch
    };
    if (fallback.profilePatch.offerings || sanitizedCompletionPatch.offerings) {
      const a = fallback.profilePatch.offerings ?? [];
      const b = sanitizedCompletionPatch.offerings ?? [];
      combinedPatch.offerings = Array.from(new Set([...a, ...b]));
    }

    const allowedEvents: PromptEventKind[] = ["skip", "create", "edit"];
    const promptEvent: PromptEventKind = allowedEvents.includes(completion.promptEvent as PromptEventKind)
      ? (completion.promptEvent as PromptEventKind)
      : "skip";
    const promptSummary = typeof completion.promptSummary === "string"
      ? completion.promptSummary.trim()
      : undefined;

    const allowedCarcass: Carcass[] = ["booking", "inspection", "sales"];
    const carcass: Carcass | null = allowedCarcass.includes(completion.carcass as Carcass)
      ? (completion.carcass as Carcass)
      : null;

    const allowedBotModels: BotModel[] = ["admin", "consultant", "support", "qualifier", "salesman"];
    const botModel: BotModel | null = allowedBotModels.includes(completion.botModel as BotModel)
      ? (completion.botModel as BotModel)
      : null;

    return {
      assistantText: sanitizeAssistantText(
        completion.assistantText ||
          (nextQuestions.length > 0
            ? `Понял. ${nextQuestions[0]}`
            : "Отлично, у меня уже достаточно данных для промпта и теста.")
      ),
      profilePatch: combinedPatch,
      nextQuestions,
      promptDraft,
      promptEvent,
      ...(promptSummary ? { promptSummary } : {}),
      carcass,
      botModel,
      readyToTest: completion.readyToTest ?? nextQuestions.length === 0,
      ...(actionButton ? { actionButton } : {}),
      notes: completion.notes
    };
  } catch (error) {
    return {
      ...fallback,
      assistantText: `${fallback.assistantText} (fallback mode: ${error instanceof Error ? error.message : "unknown error"})`
    };
  }
}

function identifyLeadNeed(text: string): { handoff: boolean; reason?: string } {
  const normalized = text.toLowerCase();

  // Only explicit handoff signals — not every question with a keyword
  const explicitHandoffPhrases = [
    "передайте менеджеру",
    "передайте специалисту",
    "хочу поговорить с человеком",
    "соедините с менеджером",
    "позвоните мне",
    "перезвоните",
    "жалоба",
    "претензия",
    "суд",
    "юридическ",
    "адвокат",
    "новый лид:",
    "передаю специалисту"
  ];

  if (explicitHandoffPhrases.some((phrase) => normalized.includes(phrase))) {
    return { handoff: true, reason: "явный запрос на передачу человеку" };
  }

  return { handoff: false };
}

export async function buildRuntimeTurn(
  profile: BusinessProfile,
  userText: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  options: { systemOverride?: string | null; detectedNeed?: string | null; telemetry?: LlmTelemetryHooks } = {}
): Promise<RuntimeTurn> {
  const summary = summarizeLead(profile, userText);
  const handoff = identifyLeadNeed(userText);
  const override = options.systemOverride && options.systemOverride.trim().length > 0
    ? options.systemOverride
    : null;
  const systemPrompt = override ?? buildRuntimePrompt(profile);

  // ПОРЯДОК ВАЖЕН: envelope v2.3 принимает бизнес-промпт первым аргументом и сам
  // склеивает его с блоками роли/потребности/механики/handoff и контрактом.
  // profile несёт botModel/carcass (подмешиваются вызывающим кодом из Agent).
  const runtimeSystem = buildRuntimeEnvelope(systemPrompt, profile, options.detectedNeed ?? null);

  try {
    const wrapper = await runJsonCallWithTelemetry<{
      reply?: string;
      shouldHandoff?: boolean;
      handoffType?: "hot_lead" | "complaint" | "out_of_scope" | "requested" | null;
      summary?: string;
      extractedNeed?: string;
      needChanged?: boolean;
      actionButton?: ActionButton;
    }>({
      system: runtimeSystem,
      messages: [
        ...history.map((message) => ({
          role: message.role,
          content: message.content
        })),
        {
          role: "user",
          content: userText
        }
      ],
      temperature: 0.4
    }, options.telemetry);

    if (wrapper.blocked) {
      // Бюджет исчерпан — отдаём дружелюбный fallback вместо тишины бота.
      return {
        reply: "Извините, сейчас мне нужно немного подождать перед ответом. Можно повторить чуть позже?",
        shouldHandoff: false,
        summary
      };
    }
    const completion = wrapper.result;

    if (!completion || !completion.reply) {
      throw new Error("empty completion");
    }

    // extractedNeed — строка (тримим), иначе пустая. needChanged — строго boolean
    // true; всё прочее (включая строку "true") приводим к false.
    const extractedNeed = typeof completion.extractedNeed === "string"
      ? completion.extractedNeed.trim()
      : "";
    const needChanged = completion.needChanged === true;

    return {
      reply: sanitizeAssistantText(completion.reply),
      shouldHandoff: completion.shouldHandoff ?? handoff.handoff,
      ...(completion.handoffType !== undefined ? { handoffType: completion.handoffType } : {}),
      summary: completion.summary || summary,
      extractedNeed,
      needChanged,
      ...(completion.actionButton ? { actionButton: completion.actionButton } : {})
    };
  } catch (error) {
    console.error("[buildRuntimeTurn] LLM call failed", error);
    if (handoff.handoff) {
      return {
        reply: "Передаю специалисту, чтобы он быстро помог с этим вопросом.",
        shouldHandoff: true,
        summary
      };
    }

    // Модельный fallback: если роль бота известна — берём готовый текст под неё.
    const fallbackModel = profile.botModel;
    if (fallbackModel && RUNTIME_FALLBACK[fallbackModel]) {
      return {
        reply: RUNTIME_FALLBACK[fallbackModel],
        shouldHandoff: false
      };
    }

    const greetingHints = /\b(привет|здравствуй|здравствуйте|hi|hello|салам|ассалам|добрый\s+день|добрый\s+вечер|доброе\s+утро)\b/i;
    if (greetingHints.test(userText)) {
      const brand = profile.businessName ? `Это ${profile.businessName}.` : "";
      return {
        reply: `Здравствуйте! ${brand} С чем нужна помощь?`.replace(/\s+/g, " ").trim(),
        shouldHandoff: false
      };
    }

    return {
      reply:
        profile.bookingFlow ||
        "Поможем. Подскажите, пожалуйста, что именно вас интересует и какой результат вам нужен?",
      shouldHandoff: false
    };
  }
}

export function buildFallbackPrompt(profile: BusinessProfile): string {
  return buildPromptFromProfile(profile);
}

export type CorrectionResult = {
  newPrompt: string;
  assistantText: string;
  changeSummary: string;
  correctionType?: string;
  sectionEdited?: string;
  // Новая роль бота при correctionType="model" — бэкенд обновит agent.botModel.
  newBotModel?: BotModel;
};

export async function applyPromptCorrection(params: {
  currentPrompt: string;
  correctionText: string;
  badBotMessage?: string;
  userMessage?: string;
  profile: BusinessProfile;
  telemetry?: LlmTelemetryHooks;
}): Promise<CorrectionResult> {
  const { currentPrompt, correctionText, badBotMessage, userMessage, profile, telemetry } = params;

  const base = currentPrompt && currentPrompt.trim().length > 80
    ? currentPrompt
    : buildPromptFromProfile(profile);

  try {
    const wrapper = await runJsonCallWithTelemetry<{
      newPrompt?: string;
      assistantText?: string;
      changeSummary?: string;
      correctionType?: string;
      sectionEdited?: string;
      newBotModel?: BotModel | null;
    }>({
      system: buildCorrectionSystemPrompt(),
      messages: [
        {
          role: "user",
          content: [
            "## ТЕКУЩИЙ ПРОМПТ",
            base,
            "",
            userMessage ? `## Что писал клиент\n"${userMessage}"` : "",
            badBotMessage ? `## Как бот ответил (это не нравится владельцу)\n"${badBotMessage}"` : "",
            "",
            "## Правка от владельца",
            correctionText,
            "",
            "Перепиши промпт так, чтобы правка реально влияла на ответы. Верни JSON."
          ].filter(Boolean).join("\n")
        }
      ],
      temperature: 0.2
    }, telemetry);

    if (wrapper.blocked) {
      // Бюджет исчерпан — даём явный сигнал, что коррекция не применена.
      return {
        newPrompt: base,
        assistantText: "Сейчас не получилось обновить правила бота (лимит запросов). Попробуйте чуть позже.",
        changeSummary: correctionText.slice(0, 120)
      };
    }
    const completion = wrapper.result;

    if (!completion || !completion.newPrompt || completion.newPrompt.length < 80) {
      throw new Error("empty correction");
    }

    return {
      newPrompt: completion.newPrompt,
      assistantText: sanitizeAssistantText(
        completion.assistantText ||
          `Готово, учёл правку — попробуй задать тот же вопрос боту ещё раз.`
      ),
      changeSummary: completion.changeSummary?.trim() || correctionText.slice(0, 120),
      ...(completion.correctionType ? { correctionType: completion.correctionType } : {}),
      ...(completion.sectionEdited ? { sectionEdited: completion.sectionEdited } : {}),
      ...(["admin", "consultant", "support", "qualifier", "salesman"].includes(completion.newBotModel as string)
        ? { newBotModel: completion.newBotModel as BotModel }
        : {})
    };
  } catch {
    const appended = `${base}\n\n## Уточнение от владельца (правка ${new Date().toISOString().slice(0, 10)})\n- ${correctionText}`;
    return {
      newPrompt: appended,
      assistantText: "Добавил твою правку в правила бота. Попробуй спросить ещё раз — должен ответить по-новому.",
      changeSummary: correctionText.slice(0, 120)
    };
  }
}

export function createInitialProfile(): BusinessProfile {
  return businessProfileSchema.parse({
    offerings: [],
    languages: ["ru"],
    faq: [],
    examples: [],
    notAllowed: [],
    channels: ["whatsapp"],
    integrations: [],
    emergencyCases: []
  });
}

export {
  buildBuilderSystemPrompt,
  buildCorrectionSystemPrompt,
  buildPromptFromProfile,
  buildRuntimeEnvelope,
  buildRuntimePrompt,
  getNextQuestions,
  mergeProfile,
  summarizeLead,
  completeStream,
  type StreamChunk
};

export {
  calcCostMicroUsd,
  completeJsonWithUsage,
  runJsonCallWithTelemetry,
  transcribeAudio,
  type LlmUsage,
  type LlmCallTelemetry,
  type LlmTelemetryHooks
} from "./openai.js";
