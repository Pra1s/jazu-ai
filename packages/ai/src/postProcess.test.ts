import { describe, expect, it } from "vitest";
import { stripDashes, tidyWhitespace, postProcessUserText } from "./postProcess.js";

describe("stripDashes — числовые диапазоны сохраняем дефисом (НЕ запятой)", () => {
  it("10–12 (en-dash) -> 10-12", () => {
    expect(stripDashes("10–12")).toBe("10-12");
  });

  it("10—12 (em-dash) -> 10-12", () => {
    expect(stripDashes("10—12")).toBe("10-12");
  });

  it("диапазон с пробелами вокруг тире остаётся диапазоном, а не двумя числами", () => {
    expect(stripDashes("оценка 25 000 — 40 000")).toBe("оценка 25 000-40 000");
    // критично: НЕ должно стать "25 000, 40 000"
    expect(stripDashes("оценка 25 000 — 40 000")).not.toContain(", ");
  });

  it("часы 9:00–18:00 -> 9:00-18:00", () => {
    expect(stripDashes("работаем 9:00–18:00")).toBe("работаем 9:00-18:00");
  });
});

describe("stripDashes — тире-пауза становится запятой", () => {
  it("' — ' с пробелами по обе стороны -> ', '", () => {
    expect(stripDashes("Записать вас — на какое время?")).toBe("Записать вас, на какое время?");
  });

  it("двойной дефис ' -- ' -> ', '", () => {
    expect(stripDashes("это удобно -- я запишу")).toBe("это удобно, я запишу");
  });
});

describe("stripDashes — что НЕ трогаем", () => {
  it("обычный дефис в слове сохраняется", () => {
    expect(stripDashes("ответит по-новому")).toBe("ответит по-новому");
  });

  it("закрытое тире без пробелов между буквами не трогаем", () => {
    expect(stripDashes("да—нет")).toBe("да—нет");
  });

  it("пустая строка проходит без изменений", () => {
    expect(stripDashes("")).toBe("");
  });
});

describe("tidyWhitespace", () => {
  it("схлопывает кратные пробелы", () => {
    expect(tidyWhitespace("а    б")).toBe("а б");
  });

  it("убирает пробел перед пунктуацией", () => {
    expect(tidyWhitespace("привет , как дела ?")).toBe("привет, как дела?");
  });

  it("срезает хвостовые пробелы и тримит", () => {
    expect(tidyWhitespace("  строка   \n")).toBe("строка");
  });

  it("переводы строк сохраняются", () => {
    expect(tidyWhitespace("раз\nдва")).toBe("раз\nдва");
  });
});

describe("postProcessUserText — композиция", () => {
  it("чистит тире и нормализует пробелы за один проход", () => {
    expect(postProcessUserText("Записать вас — на какое время?")).toBe("Записать вас, на какое время?");
  });

  it("сохраняет ценовой диапазон", () => {
    expect(postProcessUserText("оценка 25 000 — 40 000")).toBe("оценка 25 000-40 000");
  });

  it("в результате нет длинного/среднего тире", () => {
    const out = postProcessUserText("Да, делаем — оценка 25 000 — 40 000, записать вас — на когда?");
    expect(out).not.toMatch(/[—–]/);
  });

  it("пустая строка (спам/офф-топик) остаётся пустой", () => {
    expect(postProcessUserText("")).toBe("");
  });
});
