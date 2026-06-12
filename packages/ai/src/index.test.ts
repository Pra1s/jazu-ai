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
