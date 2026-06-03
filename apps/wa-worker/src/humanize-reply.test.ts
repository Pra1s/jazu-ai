import { describe, it, expect } from "vitest";
import {
  computeRemainingWait,
  computeTypingDurationMs,
  randomInt
} from "./humanize-reply.js";

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

  it("computeTypingDurationMs caps by remaining wait", () => {
    const config = {
      typingMinMs: 5000,
      typingMaxMs: 12000,
      typingFirstMinMs: 8000,
      typingFirstMaxMs: 20000
    };
    expect(computeTypingDurationMs(true, 3000, config)).toBe(3000);
    expect(computeTypingDurationMs(false, 0, config)).toBe(0);
  });
});
