import { describe, expect, it } from "vitest";
import type { BusinessProfile } from "@jazu/shared";
import { SECTION_NAMES, formatRoleCarcassMapping } from "@jazu/shared";
import {
  assertPromptShape,
  buildBuilderSystemPrompt,
  buildRuntimeEnvelope,
  getFallback,
  resolveCarcass,
  parsePromptSections,
  assemblePrompt,
  applySectionPatches,
  mergeProfile,
  stripEmptyPatchValues,
  buildPromptFromProfile,
  ENRICHMENT_FIELD_SECTION,
  RUNTIME_FALLBACK
} from "./prompts.js";

function profile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  return {
    languages: ["ru"],
    faq: [],
    examples: [],
    notAllowed: [],
    channels: ["whatsapp"],
    integrations: [],
    emergencyCases: [],
    ...overrides
  } as BusinessProfile;
}

describe("stripEmptyPatchValues (К1: пустые значения не затирают профиль)", () => {
  it("выкидывает null/undefined/пустую строку/пустой массив, оставляет реальные", () => {
    const patch = stripEmptyPatchValues({
      niche: "",
      servicesList: [],
      geography: "   ",
      businessName: null,
      leadGoal: undefined,
      botModel: "admin",
      offerings: ["стрижка"]
    });
    expect(patch).not.toHaveProperty("niche");
    expect(patch).not.toHaveProperty("servicesList");
    expect(patch).not.toHaveProperty("geography");
    expect(patch).not.toHaveProperty("businessName");
    expect(patch).not.toHaveProperty("leadGoal");
    expect(patch).toEqual({ botModel: "admin", offerings: ["стрижка"] });
  });

  it("после чистки merge НЕ затирает уже собранные niche/servicesList", () => {
    const base = profile({ niche: "барбершоп", servicesList: ["стрижка", "борода"] });
    // LLM вернул пустые значения для уже известных полей (типичный Gemini free-tier).
    const raw = stripEmptyPatchValues({ niche: "", servicesList: [], leadGoal: "запись" });
    const merged = mergeProfile(base, raw);
    expect(merged.niche).toBe("барбершоп");
    expect(merged.servicesList).toEqual(["стрижка", "борода"]);
    expect(merged.leadGoal).toBe("запись");
  });

  it("без чистки пустые значения затёрли бы базу (доказательство риска)", () => {
    const base = profile({ niche: "барбершоп", servicesList: ["стрижка"] });
    const merged = mergeProfile(base, { niche: "", servicesList: [] });
    expect(merged.niche).toBe("");
    expect(merged.servicesList).toEqual([]);
  });
});

describe("buildPromptFromProfile (П3: прайс из формы не теряется)", () => {
  it("рендерит строку Цены, когда pricingPolicy заполнен", () => {
    const out = buildPromptFromProfile(profile({
      niche: "барбершоп",
      offerings: [],
      servicesList: [],
      pricingPolicy: "Стрижка 5000, борода 2000"
    }));
    expect(out).toContain("Цены: Стрижка 5000, борода 2000");
  });

  it("не вставляет висячую строку Цены при пустом pricingPolicy", () => {
    const out = buildPromptFromProfile(profile({ niche: "барбершоп", offerings: [], servicesList: [] }));
    expect(out).not.toContain("Цены:");
  });
});

describe("resolveCarcass", () => {
  it("null + любая роль даёт дефолт роли, не inspection", () => {
    expect(resolveCarcass("admin", null)).toBe("booking");
    expect(resolveCarcass("consultant", null)).toBe("sales");
    expect(resolveCarcass("salesman", null)).toBe("sales");
    expect(resolveCarcass("support", null)).toBe("resolution");
    expect(resolveCarcass("qualifier", null)).toBe("lead_capture");
    // inspection дефолтом не подставляется никогда
    for (const m of ["admin", "consultant", "support", "qualifier", "salesman"] as const) {
      expect(resolveCarcass(m, null)).not.toBe("inspection");
    }
  });

  it("override inspection уважается для любой роли", () => {
    expect(resolveCarcass("admin", "inspection")).toBe("inspection");
    expect(resolveCarcass("qualifier", "inspection")).toBe("inspection");
  });

  it("null-модель без override даёт null", () => {
    expect(resolveCarcass(null, null)).toBeNull();
  });
});

describe("getFallback / RUNTIME_FALLBACK", () => {
  it("RUNTIME_FALLBACK[*] это непустой массив строк", () => {
    for (const model of ["admin", "consultant", "support", "qualifier", "salesman"] as const) {
      expect(Array.isArray(RUNTIME_FALLBACK[model])).toBe(true);
      expect(RUNTIME_FALLBACK[model].length).toBeGreaterThan(0);
      for (const txt of RUNTIME_FALLBACK[model]) {
        expect(typeof txt).toBe("string");
        expect(txt.length).toBeGreaterThan(0);
      }
    }
  });

  it("getFallback(null) не кидает и возвращает нейтральную строку", () => {
    const reply = getFallback(null);
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });

  it("getFallback('admin') берёт из пула роли", () => {
    const reply = getFallback("admin");
    expect(RUNTIME_FALLBACK.admin).toContain(reply);
  });
});

describe("assertPromptShape", () => {
  it("промпт без секции Задача бота даёт note без падения", () => {
    const notes = assertPromptShape(`${SECTION_NAMES.about}\n...\n${SECTION_NAMES.start}`, "admin");
    expect(notes).toContain(`missing_section:${SECTION_NAMES.task}`);
  });

  it("полный промпт с известной ролью даёт пустой список", () => {
    const full = `${SECTION_NAMES.about}\n${SECTION_NAMES.task}\n${SECTION_NAMES.start}`;
    expect(assertPromptShape(full, "admin")).toEqual([]);
  });

  it("неизвестная роль добавляет missing_botModel", () => {
    const full = `${SECTION_NAMES.about}\n${SECTION_NAMES.task}\n${SECTION_NAMES.start}`;
    expect(assertPromptShape(full, null)).toContain("missing_botModel");
  });
});

describe("buildRuntimeEnvelope", () => {
  it("содержит блок открытия и ключевые поведенческие блоки", () => {
    const out = buildRuntimeEnvelope("BIZ", profile({ botModel: "admin" }), null);
    expect(out).toContain("## ОТКРЫТИЕ ДИАЛОГА (ВЕДЁТ КЛИЕНТ)");
    expect(out).toContain("## ДОЗИРУЙ ИНФОРМАЦИЮ");
    expect(out).toContain("## ТЫ ЖИВОЙ ЧЕЛОВЕК");
    expect(out).toContain("## ОТ ПОТРЕБНОСТИ К ЗАКРЫТИЮ");
  });

  it("ветка lead_capture для qualifier (дефолт роли)", () => {
    const out = buildRuntimeEnvelope("BIZ", profile({ botModel: "qualifier" }), null);
    expect(out).toContain("## МЕХАНИКА (lead_capture)");
  });

  it("ветка resolution для support (дефолт роли)", () => {
    const out = buildRuntimeEnvelope("BIZ", profile({ botModel: "support" }), null);
    expect(out).toContain("## МЕХАНИКА (resolution)");
  });

  it("override inspection даёт ветку inspection даже у qualifier", () => {
    const out = buildRuntimeEnvelope("BIZ", profile({ botModel: "qualifier", carcass: "inspection" }), null);
    expect(out).toContain("## МЕХАНИКА (inspection)");
  });

  it("reply-инструкции не содержат длинного тире (кроме стрелок)", () => {
    const out = buildRuntimeEnvelope("BIZ", profile({ botModel: "admin" }), null);
    // выкидываем стрелку → и оставляем проверку именно на — / –
    const reply = out.split("## Формат вывода")[1] ?? out;
    expect(reply).not.toMatch(/[—–]/);
  });
});

describe("buildBuilderSystemPrompt", () => {
  it("содержит точные SECTION_NAMES из контракта", () => {
    const out = buildBuilderSystemPrompt(profile());
    expect(out).toContain(SECTION_NAMES.about);
    expect(out).toContain(SECTION_NAMES.task);
    expect(out).toContain(SECTION_NAMES.start);
    expect(out).toContain(SECTION_NAMES.handoff);
  });

  it("содержит маппинг роль→каркас из formatRoleCarcassMapping()", () => {
    const out = buildBuilderSystemPrompt(profile());
    expect(out).toContain(formatRoleCarcassMapping());
  });
});

describe("обогащение: детерминированная раскладка по секциям", () => {
  const sample = [
    "Преамбула про бота.",
    "",
    `${SECTION_NAMES.about}`,
    "Барбершоп. Услуги: стрижки.",
    "",
    `${SECTION_NAMES.canSay}`,
    "Цены уточняет специалист.",
    "",
    `${SECTION_NAMES.limits}`,
    "Не выдумывать цены.",
  ].join("\n");

  it("parsePromptSections разбирает преамбулу и секции, round-trip сохраняет текст", () => {
    const { preamble, sections } = parsePromptSections(sample);
    expect(preamble).toBe("Преамбула про бота.");
    expect(sections.map((s) => s.header)).toEqual([
      SECTION_NAMES.about, SECTION_NAMES.canSay, SECTION_NAMES.limits,
    ]);
    expect(sections[0]?.body).toBe("Барбершоп. Услуги: стрижки.");
    // round-trip: повторный разбор собранного промпта даёт те же секции
    const reassembled = assemblePrompt(preamble, sections);
    const again = parsePromptSections(reassembled);
    expect(again.preamble).toBe(preamble);
    expect(again.sections).toEqual(sections);
  });

  it("applySectionPatches заменяет тело существующей канонической секции на месте", () => {
    const { newPrompt, sectionsApplied } = applySectionPatches(sample, {
      [SECTION_NAMES.canSay]: "Стрижка — 5000 ₸.",
    });
    expect(sectionsApplied).toEqual([SECTION_NAMES.canSay]);
    const { sections } = parsePromptSections(newPrompt);
    const canSay = sections.find((s) => s.header === SECTION_NAMES.canSay);
    expect(canSay?.body).toBe("Стрижка — 5000 ₸.");
    // порядок секций не нарушен, прочие секции целы
    expect(sections.map((s) => s.header)).toEqual([
      SECTION_NAMES.about, SECTION_NAMES.canSay, SECTION_NAMES.limits,
    ]);
    expect(sections.find((s) => s.header === SECTION_NAMES.about)?.body).toContain("стрижки");
  });

  it("applySectionPatches ОТБРАСЫВАЕТ неканонические/выдуманные заголовки", () => {
    const { newPrompt, sectionsApplied } = applySectionPatches(sample, {
      "## Услуги и цены": "Стрижка — 5000 ₸.",
      "## Прайс": "что-то",
    });
    expect(sectionsApplied).toEqual([]);
    expect(newPrompt).not.toContain("## Услуги и цены");
    expect(newPrompt).not.toContain("## Прайс");
  });

  it("applySectionPatches вставляет отсутствующую каноническую секцию по порядку", () => {
    // dialog идёт ПЕРЕД canSay в каноническом порядке → должна встать между about и canSay
    const { newPrompt } = applySectionPatches(sample, {
      [SECTION_NAMES.dialog]: "Тон дружелюбный.",
    });
    const headers = parsePromptSections(newPrompt).sections.map((s) => s.header);
    expect(headers).toEqual([
      SECTION_NAMES.about, SECTION_NAMES.dialog, SECTION_NAMES.canSay, SECTION_NAMES.limits,
    ]);
  });

  it("applySectionPatches игнорирует пустые тела", () => {
    const { sectionsApplied } = applySectionPatches(sample, { [SECTION_NAMES.about]: "   " });
    expect(sectionsApplied).toEqual([]);
  });

  it("ENRICHMENT_FIELD_SECTION принимает branches (имя поля прод-формы) как синоним locations → about", () => {
    expect(ENRICHMENT_FIELD_SECTION.branches).toBe("about");
    expect(ENRICHMENT_FIELD_SECTION.branches).toBe(ENRICHMENT_FIELD_SECTION.locations);
  });

  it("applySectionPatches обезвреживает markdown-заголовки в теле (нет фантомных секций)", () => {
    const { newPrompt } = applySectionPatches(sample, {
      [SECTION_NAMES.canSay]: "## ПРАЙС\nСтрижка — 5000 ₸\n### Доп\nБорода — 3000 ₸",
    });
    const headers = parsePromptSections(newPrompt).sections.map((s) => s.header);
    // среди заголовков ТОЛЬКО канонические из sample, никаких "## ПРАЙС"/"### Доп"
    expect(headers).toEqual([SECTION_NAMES.about, SECTION_NAMES.canSay, SECTION_NAMES.limits]);
    expect(newPrompt).toContain("ПРАЙС");          // сам текст сохранён
    expect(newPrompt).toContain("Стрижка — 5000 ₸");
    expect(newPrompt).not.toMatch(/^#{1,6}\s+ПРАЙС/m); // но не как заголовок
  });
});
