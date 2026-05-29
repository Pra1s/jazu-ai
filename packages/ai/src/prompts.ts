import { businessProfileSchema, clampQuestions, type BusinessProfile } from "@jazu/shared";

type InterviewSection = {
  key: keyof BusinessProfile;
  label: string;
  question: string;
  followUp?: string;
  examples?: string[];
};

const interviewSections: InterviewSection[] = [
  {
    key: "businessName",
    label: "Название бизнеса",
    question: "Как называется бизнес?"
  },
  {
    key: "niche",
    label: "Ниша",
    question: "Чем занимаетесь в одном слове? Например, **ремонт**, **доставка**, **услуги** или **товары**?"
  },
  {
    key: "description",
    label: "Короткое описание",
    question: "Главное, что вы продаёте — это **услуга**, **товар** или **и то и другое**?"
  },
  {
    key: "offerings",
    label: "Продукты и услуги",
    question: "Главная услуга в одном слове?"
  },
  {
    key: "targetAudience",
    label: "Аудитория",
    question: "Кто ваши клиенты — **частные лица**, **бизнес** или **и те и те**?"
  },
  {
    key: "geography",
    label: "География",
    question: "Работаете только по **своему городу**, **всей стране** или **онлайн**?"
  },
  {
    key: "hours",
    label: "Часы работы",
    question: "Приём заявок **с 9 до 18**, **круглосуточно** или **другое**?"
  },
  {
    key: "pricingPolicy",
    label: "Цены",
    question: "Бот должен называть цену **сразу**, говорить **'от'** или **отдавать менеджеру**?"
  },
  {
    key: "bookingFlow",
    label: "Сценарий заявки",
    question: "Что нужно от клиента в первую очередь — **телефон**, **фото** или **адрес**?"
  },
  {
    key: "leadGoal",
    label: "Цель диалога",
    question: "Хороший итог переписки — **запись**, **звонок менеджера** или **оплата**?"
  },
  {
    key: "handoffRules",
    label: "Передача человеку",
    question: "Когда передавать человеку — **на жалобу**, **на сложный вопрос** или **всегда после первого ответа**?"
  },
  {
    key: "tone",
    label: "Тон общения",
    question: "Тон бота — **дружелюбный**, **деловой** или **премиальный**?"
  },
  {
    key: "phonePolicy",
    label: "Телефон и контакты",
    question: "Просить телефон **сразу**, **только в конце** или **не просить**?"
  },
  {
    key: "addressPolicy",
    label: "Адрес и локация",
    question: "Адрес клиента нужен **сразу**, **на этапе заявки** или **не нужен**?"
  },
  {
    key: "languages",
    label: "Языки",
    question: "Бот отвечает только на **русском**, **на казахском** или **на двух**?"
  },
  {
    key: "faq",
    label: "Частые вопросы",
    question: "Самый частый вопрос клиентов в одном слове — **цена**, **сроки** или **наличие**?"
  },
  {
    key: "examples",
    label: "Примеры",
    question: "Какой ответ бота — образец? Скиньте одну реальную фразу, как вы сами отвечаете."
  },
  {
    key: "integrations",
    label: "Интеграции",
    question: "Нужна **CRM**, **Google Календарь** или **пока без интеграций**?"
  },
  {
    key: "emergencyCases",
    label: "Сложные случаи",
    question: "Когда бот ОБЯЗАН молчать и звать вас — **на жалобу**, **на юридический вопрос** или **на крупный заказ**?"
  },
  {
    key: "notes",
    label: "Дополнительно",
    question: "Что-то ещё важное добавить — **да** или **нет**?"
  }
];

const requiredKeys: Array<keyof BusinessProfile> = [
  "businessName",
  "niche",
  "description",
  "offerings",
  "targetAudience",
  "geography",
  "hours",
  "pricingPolicy",
  "bookingFlow",
  "leadGoal",
  "handoffRules",
  "tone",
  "phonePolicy",
  "addressPolicy",
  "faq",
  "examples",
  "integrations",
  "emergencyCases"
];

function isFilled(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return value !== undefined && value !== null;
}

export function mergeProfile(base: BusinessProfile, patch: Partial<BusinessProfile>): BusinessProfile {
  const merged: BusinessProfile = {
    ...base,
    ...patch,
    offerings: patch.offerings ?? base.offerings,
    languages: patch.languages ?? base.languages,
    faq: patch.faq ?? base.faq,
    examples: patch.examples ?? base.examples,
    notAllowed: patch.notAllowed ?? base.notAllowed,
    channels: patch.channels ?? base.channels,
    integrations: patch.integrations ?? base.integrations,
    emergencyCases: patch.emergencyCases ?? base.emergencyCases
  };

  return businessProfileSchema.parse(merged);
}

export function inferMissingSections(profile: BusinessProfile): InterviewSection[] {
  const missing = interviewSections.filter((section) => {
    const value = profile[section.key];
    return !isFilled(value) && requiredKeys.includes(section.key);
  });

  return missing;
}

export function getNextQuestions(profile: BusinessProfile, max = 2): string[] {
  const missing = inferMissingSections(profile);
  return clampQuestions(
    missing.map((section) => section.followUp ? `${section.question} ${section.followUp}` : section.question),
    max
  );
}

export function buildInterviewChecklist(profile: BusinessProfile): string[] {
  return interviewSections.map((section) => {
    const value = profile[section.key];
    return `${section.label}: ${isFilled(value) ? "ok" : "нужно уточнить"}`;
  });
}

export function buildPromptFromProfile(profile: BusinessProfile): string {
  const offerings = profile.offerings.length > 0 ? profile.offerings.map((item) => `- ${item}`).join("\n") : "- Уточни список услуг и продуктов";
  const faq = profile.faq.length > 0 ? profile.faq.map((item) => `- ${item}`).join("\n") : "- Добавь частые вопросы и ответы";
  const examples = profile.examples.length > 0 ? profile.examples.map((item) => `- ${item}`).join("\n") : "- Добавь 2-3 примера хороших ответов";
  const notAllowed = profile.notAllowed.length > 0 ? profile.notAllowed.map((item) => `- ${item}`).join("\n") : "- Не придумывать цены, сроки и наличие, если их нет в данных";
  const integrations = profile.integrations.length > 0 ? profile.integrations.map((item) => `- ${item}`).join("\n") : "- Пока без интеграций";
  const emergencyCases = profile.emergencyCases.length > 0 ? profile.emergencyCases.map((item) => `- ${item}`).join("\n") : "- Нестандартные или чувствительные случаи передавать человеку";

  const intro = [
    `Ты — AI-менеджер ${profile.businessName ? `для ${profile.businessName}` : "для бизнеса"}${profile.niche ? ` в нише ${profile.niche}` : ""}.`,
    profile.description ? `Коротко о компании: ${profile.description}` : "Сначала выясни, чем занимается бизнес, а потом отвечай по существу."
  ];

  return [
    ...intro,
    "",
    "## Чем занимаемся",
    offerings,
    "",
    "## Задача в переписке",
    profile.leadGoal || "Твоя цель — быстро понять запрос клиента, собрать минимум данных и довести его до следующего шага.",
    "",
    "## Что нужно узнать у клиента",
    profile.bookingFlow || "Сначала уточни тип запроса, затем только необходимые детали для передачи специалисту или оформления заявки.",
    "",
    "## Как вести диалог",
    `- Пиши ${profile.tone || "спокойно, дружелюбно и по делу"}`,
    "- Не заваливай клиента вопросами сразу — веди по шагам",
    "- Если клиент пишет сумбурно, коротко структурируй ситуацию и помоги двигаться дальше",
    "- Если клиенту сложно объяснить, предложи фото, документы, скриншоты или короткое голосовое сообщение",
    "- Если вопрос понятен, веди к следующему шагу",
    profile.phonePolicy ? `- ${profile.phonePolicy}` : "- Не проси дублировать контактные данные, если они уже есть в мессенджере",
    profile.addressPolicy ? `- ${profile.addressPolicy}` : "- Адрес спрашивай только если он действительно нужен",
    "",
    "## Когда передавать специалисту",
    profile.handoffRules || "Передавай, когда запрос требует человека, нестандартен, чувствителен или клиент готов обсудить детали.",
    "",
    "## Частые вопросы",
    faq,
    "",
    "## Примеры правильных ответов",
    examples,
    "",
    "## Интеграции",
    integrations,
    "",
    "## Сложные случаи",
    emergencyCases,
    "",
    "## Границы",
    notAllowed,
    "",
    "## Summary в тред",
    "Если нужно передать лид, пиши короткий summary: кто пишет, что хочет, какие детали уже известны, насколько срочно и что делать дальше.",
    "",
    "## Первый ход",
    "Начинай с самого важного вопроса по контексту. Не задавай общий вопрос, если пользователь уже описал бизнес или запрос."
  ].join("\n");
}

export function buildBuilderSystemPrompt(profile: BusinessProfile): string {
  const filledLines = interviewSections
    .map((section) => {
      const value = profile[section.key];
      if (!isFilled(value)) return null;
      const rendered = Array.isArray(value) ? value.join("; ") : String(value);
      return `- ${section.label}: ${rendered}`;
    })
    .filter(Boolean)
    .join("\n");

  const missingLabels = inferMissingSections(profile).map((section) => `- ${section.label}`).join("\n") ||
    "- Все базовые поля закрыты — можно переходить в тест";

  const profileSnapshot = filledLines || "- Пока ничего не известно";

  return `SYSTEM PROMPT · БИЛДЕР КОНВЕРСИОННОГО БОТА
Ты — AI-настройщик WhatsApp-ботов для бизнеса и самозанятых. Твоя цель — не собирать скучную анкету, а за 3-5 шагов спроектировать жесткую воронку продаж и квалификации лидов, которая заменит живого продажника.

## Главное правило
Ты ведешь живой, уверенный разговор. Сначала разберись, что сказал пользователь, а затем веди его по "Алгоритму Воронки".

## Что уже известно про бизнес
${profileSnapshot}

## Что ещё не закрыто
${missingLabels}

## Алгоритм каждого ответа
1. ПОЙМИ сообщение пользователя.
2. КЛАССИФИЦИРУЙ его:
   a) содержательный ответ -> зафиксируй данные в profilePatch и двигай юзера на следующий шаг "Алгоритма Воронки";
   b) уточняющий вопрос -> объясни зачем это нужно и дай готовые примеры;
   c) пустое/неясное ("да", "ок") -> НЕ задавай новый вопрос. Дай 2-3 варианта ответа для его ниши;
   d) офф-топик -> верни к настройке одним предложением;
   e) юзер говорит "давай тест" / "хватит" -> финализируй prompt и ставь readyToTest=true.
3. Выбери ОДИН следующий вопрос согласно Алгоритму.

## АЛГОРИТМ ВОРОНКИ (Веди пользователя строго по этим шагам)
ШАГ 1. НИША: Пойми, что конкретно продаем.
ШАГ 2. ЦЕЛЕВОЕ ДЕЙСТВИЕ (leadGoal): К чему бот должен довести клиента? Предложи варианты: прямая запись на время, выезд на замер/диагностику, или расчет/продажа.
ШАГ 3. КВАЛИФИКАЦИЯ (bookingFlow): Какие 1-2 вопроса бот должен задать клиенту, чтобы понять объем работы или чек? (например: марка авто, площадь квартиры, возраст ученика).
ШАГ 4. АНТИ-ЛИДЫ (notAllowed): С кем бот должен сразу прощаться или звать человека? (например: нужна рассрочка, другой город, мелкий ремонт).

## Формат сообщения пользователю (assistantText)
- Формула: [Инсайт/Подтверждение маркетолога] + [Следующий вопрос с вариантами в bold].
- Хорошо: "Отлично, для ремонта главное — понять объем. Бот будет сначала спрашивать: это косметика, капитальный или под ключ?"
- Плохо: "Принял. Опишите процесс вашей работы."
- Не извиняйся без повода, не пиши "Итак". Живой чат.

## КАК ФОРМУЛИРОВАТЬ ВОПРОС (КРИТИЧЕСКИ ВАЖНО)
1. В вопросе ВСЕГДА должны быть 2-3 готовых варианта в bold. Это превращает вопрос в кнопки.
2. НИКОГДА не используй слова: 'опишите', 'расскажите', 'как выглядит процесс'. 
3. Адаптируй варианты под нишу. 
4. Один вопрос = один параметр.

## СОБЫТИЕ ПРОМПТА — promptEvent (КРИТИЧЕСКИ ВАЖНО)
### promptEvent = "skip" — тихая фаза сбора
Возвращай, пока не пройден ШАГ 2 (понятно целевое действие). Карточки не будет. promptDraft оставь пустым.

### promptEvent = "create" — рождение боевого промпта
Выставляй РОВНО ОДИН РАЗ, когда понятна ниша, целевое действие и квалификация (Пройден ШАГ 3). 
- В promptDraft собери мощный system-prompt (1500-2500 символов). ОБЯЗАТЕЛЬНО добавь туда директиву: "Бот обязан удерживать инициативу: каждое сообщение должно заканчиваться вопросом, ведущим клиента к [Целевое действие]".
- В promptSummary напиши: "Собрал воронку: бот теперь не просто консультирует, а закрывает клиентов на [Целевое действие] через квалификацию по [Параметры]."

### promptEvent = "edit" — доработка
Выставляй, когда юзер дает новые условия (анти-лиды, цены, FAQ) И первый create уже был.
- В promptDraft верни ЦЕЛИКОМ обновленный промпт бота.
- В promptSummary: "Добавил жесткое правило: бот теперь [что делает]."

### readyToTest=true
Ставь true, когда собрано базовое ядро (Ниша + Квалификация + Закрытие) или юзер сам просит тест. Не выпытывай прайсы и часы работы, если юзер готов тестить. Добавляй actionButton: {type:"switch_to_test"}.

## Формат вывода
Верни СТРОГО валидный JSON без markdown. Поля:
- assistantText: string 
- profilePatch: объект с полями BusinessProfile
- nextQuestions: string[] (массив из 0 или 1 строки)
- promptEvent: "skip" | "create" | "edit"
- promptSummary: string (для skip — пустая строка)
- promptDraft: string 
- readyToTest: boolean
- actionButton: {type:"switch_to_test", label:"Протестировать"} (добавляй только при readyToTest=true)
- notes: string[]

## Язык
Отвечай на том же языке, на котором пишет пользователь. По умолчанию — русский.
`;
}

export function buildRuntimePrompt(profile: BusinessProfile): string {
  return buildPromptFromProfile(profile);
}

export function summarizeLead(profile: BusinessProfile, message: string, extra: Record<string, unknown> = {}): string {
  const parts = [
    `Новый лид: ${profile.businessName || "без названия"}`,
    profile.niche ? `ниша: ${profile.niche}` : undefined,
    profile.targetAudience ? `аудитория: ${profile.targetAudience}` : undefined,
    profile.geography ? `география: ${profile.geography}` : undefined,
    `сообщение: ${message}`,
    ...Object.entries(extra).map(([key, value]) => `${key}: ${String(value)}`)
  ].filter(Boolean);

  return parts.join(", ");
}
