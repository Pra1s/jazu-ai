import { describe, it, expect } from "vitest";
import { coerceReplyMessages, resolveBubbleCap } from "./reply-messages.js";

describe("resolveBubbleCap", () => {
  it("replySplitEnabled: false → 1, независимо от replyMaxMessages", () => {
    expect(resolveBubbleCap({ replySplitEnabled: false, replyMaxMessages: 6 })).toBe(1);
  });

  it("нет replyMaxMessages → дефолт 4", () => {
    expect(resolveBubbleCap({})).toBe(4);
  });

  it("клампит replyMaxMessages в диапазон [1, 6]", () => {
    expect(resolveBubbleCap({ replyMaxMessages: 0 })).toBe(1);
    expect(resolveBubbleCap({ replyMaxMessages: -3 })).toBe(1);
    expect(resolveBubbleCap({ replyMaxMessages: 99 })).toBe(6);
    expect(resolveBubbleCap({ replyMaxMessages: 3 })).toBe(3);
  });
});

describe("coerceReplyMessages", () => {
  it("messages: string[] — предпочтительный путь, элементы идут как есть", () => {
    expect(coerceReplyMessages({ messages: ["a", "b"] }, { cap: 4 })).toEqual(["a", "b"]);
  });

  it("нет messages, есть legacy reply с «---» — обратная совместимость", () => {
    expect(coerceReplyMessages({ reply: "a---b" }, { cap: 4 })).toEqual(["a", "b"]);
  });

  it("модель рецидивирует в «---» внутри одного элемента messages — режем и там", () => {
    expect(coerceReplyMessages({ messages: ["a---b"] }, { cap: 4 })).toEqual(["a", "b"]);
  });

  it("messages: [] — осознанное молчание, а не ошибка", () => {
    expect(coerceReplyMessages({ messages: [] }, { cap: 4 })).toEqual([]);
  });

  it("пустые/пробельные элементы отбрасываются", () => {
    expect(coerceReplyMessages({ messages: ["", "  "] }, { cap: 4 })).toEqual([]);
  });

  it("нестроковые элементы массива отбрасываются, а не роняют разбор", () => {
    expect(coerceReplyMessages({ messages: [1, "a", null, undefined, {}] }, { cap: 4 })).toEqual(["a"]);
  });

  it("переполнение сверх cap схлопывает хвост через пустую строку", () => {
    expect(coerceReplyMessages({ messages: ["a", "b", "c", "d", "e"] }, { cap: 3 })).toEqual([
      "a",
      "b",
      "c\n\nd\n\ne"
    ]);
  });

  it("cap=1 (дробление выключено) — всегда не больше одного сообщения", () => {
    const result = coerceReplyMessages({ messages: ["Первое.", "Второе.", "Третье."] }, { cap: 1 });
    expect(result.length).toBeLessThanOrEqual(1);
    expect(result).toEqual(["Первое.\n\nВторое.\n\nТретье."]);
  });

  it("ни messages, ни reply — пустой результат, не падает", () => {
    expect(coerceReplyMessages({}, { cap: 4 })).toEqual([]);
  });

  it("тире-пауза чистится поэлементно (как раньше чистился reply целиком)", () => {
    expect(coerceReplyMessages({ messages: ["Записать вас — на когда?"] }, { cap: 4 })).toEqual([
      "Записать вас, на когда?"
    ]);
  });
});
