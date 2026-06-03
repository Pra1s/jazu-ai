// packages/shared/src/botContract.ts  (экспортируется из @jazu/shared)
// Версия 3.0 — ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ для промптов и кода. Это тот же модуль, что CODE §1.
// Роли, каркасы, маппинг, названия секций и типы хэндоффа определены ЗДЕСЬ и только здесь.
// Промпт-сборщики (Builder / Runtime / Correction / Enrichment) НЕ хардкодят эти значения,
// а импортируют отсюда и подставляют через хелперы ниже. Поменяешь значение тут —
// оно изменится во всех промптах автоматически, ручная синхронизация не нужна.

export const BOT_MODELS = ["admin", "consultant", "support", "qualifier", "salesman"] as const;
export type BotModel = (typeof BOT_MODELS)[number];

export const CARCASSES = ["booking", "inspection", "sales", "lead_capture", "resolution"] as const;
export type Carcass = (typeof CARCASSES)[number];

// Дефолтный каркас для роли.
// ВНИМАНИЕ: "inspection" — OVERRIDE-ONLY, на него не указывает ни одна роль по умолчанию.
// Его ставит Билдер явно для физических ниш (оценка/замер/диагностика/ремонт/клининг).
export const ROLE_DEFAULT_CARCASS: Record<BotModel, Carcass> = {
  admin:      "booking",
  consultant: "sales",
  support:    "resolution",
  qualifier:  "lead_capture",
  salesman:   "sales",
};

// Точные названия секций промпта бота. Билдер генерирует их, Correction по ним ищет.
export const SECTION_NAMES = {
  about:      "## Чем занимаемся",
  task:       "## Задача бота",
  start:      "## С чего начинать диалог",
  qualify:    "## Что выяснить у клиента",
  dialog:     "## Как вести диалог",
  canSay:     "## Что можно говорить",
  objections: "## Работа с возражениями",
  grade:      "## Градация клиента",
  handoff:    "## Когда передавать менеджеру",
  limits:     "## Границы",
  notEnough:  "## Если информации не хватает",
  notClient:  "## Не клиент",
} as const;

// Типы хэндоффа: имя + когда срабатывает + шаблон summary. Рендерятся в промпты.
export const HANDOFF_TYPES = {
  hot_lead:     { when: "готов купить/записаться сейчас", summary: "Горячий лид: [тип], [цель], [город]" },
  complaint:    { when: "жалоба/претензия/угроза",        summary: "Жалоба: [суть], клиент [настроение]" },
  out_of_scope: { when: "вопрос вне инструкции",          summary: "Нестандартный вопрос: [суть]" },
  requested:    { when: "просит менеджера/перезвон",       summary: "Просит связи: [контекст]" },
} as const;
export type HandoffType = keyof typeof HANDOFF_TYPES;

// ── Хелперы: превращают константы выше в текст для промптов ──

// Маппинг роль→каркас строкой: "admin→booking, consultant→sales, ..." (Builder, Correction)
export function formatRoleCarcassMapping(): string {
  return (Object.keys(ROLE_DEFAULT_CARCASS) as BotModel[])
    .map((r) => `${r}→${ROLE_DEFAULT_CARCASS[r]}`)
    .join(", ");
}

// Имена типов хэндоффа через "/", для шаблона Билдера: "hot_lead / complaint / out_of_scope / requested"
export function handoffList(): string {
  return (Object.keys(HANDOFF_TYPES) as HandoffType[]).join(" / ");
}

// Полный список хэндоффа с шаблонами summary, для Рантайма:
//   - hot_lead: готов купить/записаться сейчас. summary: "..."
export function handoffTemplates(): string {
  return (Object.keys(HANDOFF_TYPES) as HandoffType[])
    .map((t) => `- ${t}: ${HANDOFF_TYPES[t].when}. summary: "${HANDOFF_TYPES[t].summary}"`)
    .join("\n");
}

// JSON-union'ы для блоков «Формат вывода»:
export function botModelEnum(): string {
  return BOT_MODELS.map((m) => `"${m}"`).join(" | ");
}
export function carcassEnum(): string {
  return CARCASSES.map((c) => `"${c}"`).join(" | ");
}
export function handoffEnum(): string {
  return (Object.keys(HANDOFF_TYPES) as HandoffType[]).map((t) => `"${t}"`).join(" | ");
}
