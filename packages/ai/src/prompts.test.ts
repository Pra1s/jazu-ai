import { describe, expect, it } from "vitest";
import type { BusinessProfile } from "@jazu/shared";
import { SECTION_NAMES, formatRoleCarcassMapping } from "@jazu/shared";
import {
  assertPromptShape,
  buildBuilderSystemPrompt,
  buildRuntimeEnvelope,
  getFallback,
  resolveCarcass,
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
