import { describe, it, expect } from "vitest";
import {
  computeBubblePauseMs,
  computeRemainingWait,
  computeTypingDurationMs,
  randomInt
} from "./humanize-reply.js";

const config = {
  typingMinMs: 2500,
  typingMaxMs: 9000,
  typingFirstMinMs: 3500,
  typingFirstMaxMs: 12000
};

describe("humanize-reply", () => {
  it("computeRemainingWait never goes negative", () => {
    expect(computeRemainingWait(1000, 2000)).toBe(0);
    expect(computeRemainingWait(5000, 2000)).toBe(3000);
  });

  it("randomInt stays within bounds", () => {
    for (let i = 0; i < 50; i++) {
      const v = randomInt(20, 35);
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(35);
    }
  });

  it("computeTypingDurationMs stays within the configured range", () => {
    for (let i = 0; i < 50; i++) {
      const regular = computeTypingDurationMs(false, "Да, конечно, сейчас посмотрю", config);
      expect(regular).toBeGreaterThanOrEqual(config.typingMinMs);
      expect(regular).toBeLessThanOrEqual(config.typingMaxMs);

      const first = computeTypingDurationMs(true, "Здравствуйте! Чем могу помочь?", config);
      expect(first).toBeGreaterThanOrEqual(config.typingFirstMinMs);
      expect(first).toBeLessThanOrEqual(config.typingFirstMaxMs);
    }
  });

  it("computeTypingDurationMs scales with text length", () => {
    // Короткая реплика упирается в пол, длинная — в потолок.
    expect(computeTypingDurationMs(false, "Ок", config)).toBe(config.typingMinMs);
    expect(computeTypingDurationMs(false, "а".repeat(500), config)).toBe(config.typingMaxMs);
  });

  it("computeTypingDurationMs never returns zero (индикатор виден всегда)", () => {
    // Регрессия: раньше длительность резалась остатком окна ожидания и при
    // израсходованном бюджете «печатает…» не показывалось вообще.
    expect(computeTypingDurationMs(false, "", config)).toBe(config.typingMinMs);
    expect(computeTypingDurationMs(true, "", config)).toBe(config.typingFirstMinMs);
  });

  it("computeBubblePauseMs stays within bubble bounds", () => {
    for (const text of ["Ок", "Средней длины сообщение для клиента", "б".repeat(400)]) {
      const pause = computeBubblePauseMs(text);
      expect(pause).toBeGreaterThanOrEqual(1200);
      expect(pause).toBeLessThanOrEqual(5000);
    }
  });
});
