import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessProfile } from "@jazu/shared";

// Мокаем LLM-слой целиком: index.ts и сам импортирует из ./openai.js, и ре-экспортирует
// его наружу, поэтому фабрика обязана отдать ВСЕ имена, которые index.ts трогает.
const mocks = vi.hoisted(() => ({
  runJsonCallWithTelemetry: vi.fn()
}));

vi.mock("./openai.js", () => ({
  runJsonCallWithTelemetry: mocks.runJsonCallWithTelemetry,
  sanitizeAssistantText: (s: string) => s.trim(),
  completeStream: vi.fn(),
  completeJsonWithUsage: vi.fn(),
  calcCostMicroUsd: vi.fn(),
  transcribeAudio: vi.fn(),
  setLlmKeyProvider: vi.fn()
}));

import { buildRuntimeTurn, createInitialProfile } from "./index.js";
import { RUNTIME_FALLBACK } from "./prompts.js";

function adminProfile(): BusinessProfile {
  return { ...createInitialProfile(), botModel: "admin" };
}

describe("buildRuntimeTurn: пустой reply = осознанное молчание (Р1)", () => {
  beforeEach(() => {
    mocks.runJsonCallWithTelemetry.mockReset();
  });

  it("reply:'' от LLM (спам/офф-топик) проходит как есть, без подмены fallback-текстом", async () => {
    mocks.runJsonCallWithTelemetry.mockResolvedValue({
      blocked: false,
      result: { reply: "", shouldHandoff: false }
    });
    const turn = await buildRuntimeTurn(adminProfile(), "куплю подписчиков, скинь прайс на накрутку", []);
    expect(turn.reply).toBe("");
    expect(turn.shouldHandoff).toBe(false);
  });

  it("reply отсутствует (битый JSON) в середине диалога → нейтральный fallback без приветствия", async () => {
    mocks.runJsonCallWithTelemetry.mockResolvedValue({
      blocked: false,
      result: {}
    });
    const turn = await buildRuntimeTurn(adminProfile(), "и сколько это стоит?", [
      { role: "user", content: "здравствуйте" },
      { role: "assistant", content: "Здравствуйте! Чем могу помочь?" }
    ]);
    expect(turn.reply).toBe("Извините, не расслышал. Можете повторить?");
    expect(turn.shouldHandoff).toBe(false);
  });

  it("reply отсутствует в начале диалога → приветствие из пула роли", async () => {
    mocks.runJsonCallWithTelemetry.mockResolvedValue({
      blocked: false,
      result: {}
    });
    const turn = await buildRuntimeTurn(adminProfile(), "здравствуйте", []);
    expect(RUNTIME_FALLBACK.admin).toContain(turn.reply);
    expect(turn.shouldHandoff).toBe(false);
  });
});

describe("buildRuntimeTurn: контракт messages[] (мультисообщения)", () => {
  beforeEach(() => {
    mocks.runJsonCallWithTelemetry.mockReset();
  });

  it("messages: [] от LLM — осознанное молчание (Р1), НЕ подменяется fallback-приветствием", async () => {
    // Регрессия, которую легко сломать неверным гардом: пустой МАССИВ — валидный
    // ответ модели (спам/офф-топик), а не признак битого JSON.
    mocks.runJsonCallWithTelemetry.mockResolvedValue({
      blocked: false,
      result: { messages: [], shouldHandoff: false }
    });
    const turn = await buildRuntimeTurn(adminProfile(), "куплю подписчиков, скинь прайс на накрутку", []);
    expect(turn.messages).toEqual([]);
    expect(turn.reply).toBe("");
    expect(RUNTIME_FALLBACK.admin).not.toContain(turn.reply);
  });

  it("messages: ['a','b'] — reply это join('\\n\\n'), messages сохраняет пузыри отдельно", async () => {
    mocks.runJsonCallWithTelemetry.mockResolvedValue({
      blocked: false,
      result: { messages: ["a", "b"], shouldHandoff: false }
    });
    const turn = await buildRuntimeTurn(adminProfile(), "здравствуйте", []);
    expect(turn.messages).toEqual(["a", "b"]);
    expect(turn.reply).toBe("a\n\nb");
  });

  it("ни messages, ни reply (битый JSON) → fallback тоже приходит как messages: [текст]", async () => {
    mocks.runJsonCallWithTelemetry.mockResolvedValue({
      blocked: false,
      result: {}
    });
    const turn = await buildRuntimeTurn(adminProfile(), "здравствуйте", []);
    expect(turn.messages).toHaveLength(1);
    expect(turn.messages[0]).toBe(turn.reply);
  });

  it("бюджет заблокирован (blocked: true) — messages содержит ровно один фолбэк-текст", async () => {
    mocks.runJsonCallWithTelemetry.mockResolvedValue({ blocked: true });
    const turn = await buildRuntimeTurn(adminProfile(), "здравствуйте", []);
    expect(turn.messages).toHaveLength(1);
    expect(turn.messages[0]).toBe(turn.reply);
    expect(turn.reply.length).toBeGreaterThan(0);
  });

  it("legacy reply-строка с «---» без messages — работает как раньше (обратная совместимость)", async () => {
    mocks.runJsonCallWithTelemetry.mockResolvedValue({
      blocked: false,
      result: { reply: "Здравствуйте!---Чем могу помочь?", shouldHandoff: false }
    });
    const turn = await buildRuntimeTurn(adminProfile(), "здравствуйте", []);
    expect(turn.messages).toEqual(["Здравствуйте!", "Чем могу помочь?"]);
  });
});
