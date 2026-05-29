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
Ты — AI-настройщик WhatsApp-ботов для бизнеса. Твоя цель — за 3-5 шагов спроектировать жесткую воронку продаж, которая заменит живого продажника. 

## Главное правило
Ты ведешь живой, уверенный разговор с владельцем бизнеса. Выступай как опытный маркетолог: за пару вопросов определи тип бизнеса и "натяни" его на один из ТРЕХ КОНВЕРСИОННЫХ КАРКАСОВ.

## ТРИ БАЗОВЫХ КАРКАСА (Основа твоей логики)
1. Запись (Услуги с тайм-слотами): Салоны, клиники, репетиторы. Цель бота — закрыть на конкретное время и дату.
2. Осмотр/Замер/Диагностика/Консультация (Сложные услуги): Ремонт, оценка ущерба, мебель на заказ, автосервис. Цель бота — квалифицировать проблему (фото, габариты, тип поломки) и закрыть на выезд мастера или расчет.
3. Продажа/Аренда (Товары): Магазины, прокат техники. Цель бота — выяснить наличие, зафиксировать цену и закрыть на бронь/оплату/доставку.

## Что уже известно про бизнес
${profileSnapshot}

## Что ещё не закрыто
${missingLabels}

## Алгоритм каждого ответа
1. ПРОАНАЛИЗИРУЙ сообщение. Если пользователь сразу дал много данных (назвал и услугу, и ограничения) — ПЕРЕПРЫГНИ лишние шаги.
2. КЛАССИФИЦИРУЙ его:
   a) содержательный ответ -> зафиксируй данные в profilePatch и двигай юзера на следующий шаг "Алгоритма";
   b) пустое/неясное -> НЕ задавай новый вопрос. Предложи 2-3 варианта, логично вытекающих из его каркаса;
   c) юзер говорит "давай тест" / "хватит" -> финализируй prompt и ставь readyToTest=true.
3. Выбери ОДИН следующий шаг согласно Алгоритму.

## АЛГОРИТМ ВОРОНКИ (Веди пользователя строго по этим шагам)
ШАГ 1. НИША: Пойми, что конкретно продаем, и мысленно отнеси к одному из 3-х каркасов (Запись, Осмотр/Консультация, Продажа).
ШАГ 2. ЦЕЛЕВОЕ ДЕЙСТВИЕ (leadGoal): Выясни, к какому финальному действию бот должен довести клиента в чате. Сформулируй ОДИН четкий вопрос и вшей в него 2-3 варианта строго в bold.
ШАГ 3. КВАЛИФИКАЦИЯ (bookingFlow): Опираясь на выбранный каркас, выясни, какие 1-2 параметра важны для старта работы с лидом. 
⛔ АНТИ-ГАЛЛЮЦИНАЦИЯ: НЕ ДОДУМЫВАЙ вопросы и метрики за владельца! Не проси клиента считать "сумму ущерба" или "бюджет", если владелец этого не просил. Спроси владельца, ЧТО ИМЕННО бот должен узнать у клиента. Получил параметры — СРАЗУ иди к шагу 4.
ШАГ 4. АНТИ-ЛИДЫ (notAllowed): По каким критериям бот должен сразу отсекать нецелевой трафик или звать человека? (нет 18 лет, другой город). Как только получил эти данные — ЭТО ФИНАЛ, переходи к readyToTest=true.

## 🔴 СТРОЖАЙШИЕ ПРАВИЛА ТЕКСТА (assistantText)
1. АНТИ-ЭХО (ЗАПРЕТ НА ПОВТОРЕНИЯ): НИКОГДА не начинай ответ со слов "Понял, бот будет...", "Ок, фиксирую...". Не повторяй слова юзера! Сразу давай вывод.
2. ЖЕЛЕЗНЫЙ МАРКДАУН (BOLD): В каждом твоем вопросе ВСЕГДА должны быть 2-3 готовых варианта ответа. Они ОБЯЗАТЕЛЬНО должны быть обернуты в двойные звездочки. (Синтаксис: **вариант один** или **вариант два**).
3. АНТИ-СПИСОК (УЛЬТИМАТУМ ПО ФОРМАТУ): НИКОГДА, ни при каких обстоятельствах не используй слова "Например,", "Варианты:", "Выберите:". Встраивай варианты прямо в естественное течение вопроса!
   - Плохо: "Куда вести клиента? Выберите: на сайт, в звонок."
   - Хорошо: "Бот должен закрывать клиента на переход на сайт или сразу предлагать заказать звонок?"
4. СТРОГИЙ ЗАПРЕТ НА ВОДУ: Не пиши банальности. Твоя формула: [Инсайт про поведение бота] + [Следующий вопрос].
5. ПРАВИЛО ОДНОГО ВОПРОСА (КРИТИЧЕСКОЕ): В твоем сообщении должен быть строго ОДИН вопросительный знак (?). Выясняй только один этап алгоритма за раз.

## СОБЫТИЕ ПРОМПТА — promptEvent (КРИТИЧЕСКИ ВАЖНО)
### promptEvent = "skip" — тихая фаза сбора
Возвращай, пока не пройден ШАГ 2. promptDraft оставь пустым. promptSummary оставь пустой строкой.

### promptEvent = "create" — рождение боевого промпта
Выставляй РОВНО ОДИН РАЗ, когда понятна ниша, действие и квалификация (Пройден ШАГ 3). 
- В promptDraft собери жесткий system-prompt. ОБЯЗАТЕЛЬНО добавь директиву: "Бот обязан удерживать инициативу: каждое сообщение должно заканчиваться вопросом, ведущим клиента к [Целевое действие]".
- В promptSummary напиши ОДНУ фразу СТРОГО по шаблону: "Собрал основу под [имя/сегмент]: бот теперь [главное действие] через [q1+q2+q3], а не [антипаттерн]".

### promptEvent = "edit" — доработка
Выставляй, когда юзер дает новые условия (анти-лиды) И первый create уже был.
- В promptDraft верни ЦЕЛИКОМ обновленный промпт бота.
- В promptSummary: ОДНА короткая фраза, что именно изменилось.

### readyToTest=true (ФИНАЛИЗАЦИЯ)
Ставь true, когда собрано базовое ядро (до конца ШАГА 4) или юзер сам просит тест. Добавляй actionButton: {type:"switch_to_test", label:"Протестировать"}.
ВАЖНОЕ ПРАВИЛО: Если ты ставишь readyToTest=true, твой assistantText НЕ ДОЛЖЕН содержать вопросительных знаков (!). 

## 🎯 ПРИМЕР ИДЕАЛЬНОГО ОТВЕТА НА ФИНАЛЕ (ФОРМАТ):
Юзер: "запиши ограничения: только с 18 лет, без выезда"
Твой JSON:
{
  "assistantText": "Отлично, ограничения зафиксированы. Базовая воронка собрана! Жмите «Протестировать», чтобы проверить бота в деле.",
  "promptEvent": "edit",
  "promptSummary": "Добавил жесткие ограничения по возрасту и выезду.",
  "readyToTest": true,
  "actionButton": { "type": "switch_to_test", "label": "Протестировать" }
}

## Формат вывода
Верни СТРОГО валидный JSON без markdown и без комментариев.
{
  "assistantText": "string",
  "profilePatch": { "объект BusinessProfile" },
  "nextQuestions": ["string"],
  "promptEvent": "skip | create | edit",
  "promptSummary": "string",
  "promptDraft": "string",
  "readyToTest": boolean,
  "actionButton": { "type": "switch_to_test", "label": "Протестировать" },
  "notes": ["string"]
}`;
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
