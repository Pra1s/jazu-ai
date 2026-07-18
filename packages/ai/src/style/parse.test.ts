import { describe, it, expect } from "vitest";
import {
  parseWhatsappTxt,
  parseWtsexporterJson,
  parseDialogueSource,
  maskPhones,
  maskChatLabel
} from "./parse.js";

describe("maskPhones", () => {
  it("маскирует телефоны в разных форматах", () => {
    expect(maskPhones("звоните +7 999 123-45-67 сегодня")).toBe("звоните [номер] сегодня");
    expect(maskPhones("номер 87001234567")).toBe("номер [номер]");
    expect(maskPhones("+1 (415) 555-2671")).toBe("[номер]");
  });
  it("не трогает короткие числа (цены, время)", () => {
    expect(maskPhones("цена 8000 тенге")).toBe("цена 8000 тенге");
    expect(maskPhones("в 14:30")).toBe("в 14:30");
  });
});

describe("maskChatLabel", () => {
  it("срезает расширение и телефоны", () => {
    expect(maskChatLabel("Клиент Иван.txt")).toBe("Клиент Иван");
    expect(maskChatLabel("+7 700 123 45 67.txt")).toBe("[номер]");
  });
});

describe("parseWhatsappTxt (iOS-формат)", () => {
  const sample = [
    "[12.05.2026, 14:32:10] Ильяс: Здравствуйте! Чем могу помочь?",
    "[12.05.2026, 14:35:00] Клиент: Сколько стоит стрижка?",
    "[12.05.2026, 14:35:30] Ильяс: 5000 с укладкой)",
    "многострочный хвост",
    "[12.05.2026, 14:36:00] Клиент: <Media omitted>"
  ].join("\n");

  it("разбирает реплики и роли по имени владельца", () => {
    const eps = parseWhatsappTxt(sample, { ownerName: "Ильяс", chatLabel: "Клиент" });
    expect(eps).toHaveLength(1);
    const turns = eps[0]!.turns;
    // media-строка отфильтрована → 3 реплики
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ role: "owner", text: "Здравствуйте! Чем могу помочь?" });
    expect(turns[1]).toMatchObject({ role: "client", text: "Сколько стоит стрижка?" });
    expect(turns[2]!.role).toBe("owner");
    // Продолжение приклеилось к последнему сообщению владельца
    expect(turns[2]!.text).toContain("многострочный хвост");
  });
});

describe("parseWhatsappTxt (Android-формат с дефисом)", () => {
  const sample = [
    "12/05/2026, 14:32 - Ильяс: Привет",
    "12/05/2026, 14:33 - Ильяс: Messages and calls are end-to-end encrypted.",
    "12/05/2026, 14:34 - Мария: Хочу записаться"
  ].join("\n");

  it("парсит дефисный формат и отбрасывает системные строки", () => {
    const eps = parseWhatsappTxt(sample, { ownerName: "Ильяс" });
    expect(eps).toHaveLength(1);
    const turns = eps[0]!.turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "owner", text: "Привет" });
    expect(turns[1]).toMatchObject({ role: "client", text: "Хочу записаться" });
  });
});

describe("parseWhatsappTxt — разрез на эпизоды по паузе", () => {
  const sample = [
    "[01.01.2026, 10:00:00] Ильяс: первый разговор",
    "[01.01.2026, 10:05:00] Клиент: ответ",
    "[20.01.2026, 09:00:00] Клиент: снова пишу через 19 дней",
    "[20.01.2026, 09:01:00] Ильяс: здравствуйте снова"
  ].join("\n");

  it("режет на два эпизода при разрыве больше splitDays", () => {
    const eps = parseWhatsappTxt(sample, { ownerName: "Ильяс", splitDays: 3 });
    expect(eps).toHaveLength(2);
    expect(eps[0]!.turns).toHaveLength(2);
    expect(eps[1]!.turns).toHaveLength(2);
    expect(eps[1]!.episodeIndex).toBe(1);
  });
});

describe("parseWhatsappTxt — маскирование телефонов в теле", () => {
  it("телефон в реплике заменяется на [номер]", () => {
    const eps = parseWhatsappTxt("[01.01.2026, 10:00:00] Клиент: мой номер +7 777 123 45 67", {
      ownerName: "Ильяс"
    });
    expect(eps[0]!.turns[0]!.text).toBe("мой номер [номер]");
  });
});

describe("parseWtsexporterJson", () => {
  const dump = {
    "7700000@s.whatsapp.net": {
      name: "Мария",
      messages: {
        m1: { from_me: true, timestamp: 1767258000, data: "Здравствуйте" },
        m2: { from_me: false, timestamp: 1767258060, data: "Сколько стоит?" },
        m3: { from_me: true, timestamp: 1767258120, data: "5000", meta: false, media: false },
        sys: { from_me: false, timestamp: 1767258000, data: "encrypted", meta: true }
      }
    }
  };

  it("определяет владельца по from_me и отбрасывает meta", () => {
    const eps = parseWtsexporterJson(dump);
    expect(eps).toHaveLength(1);
    const turns = eps[0]!.turns;
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ role: "owner", text: "Здравствуйте" });
    expect(turns[1]).toMatchObject({ role: "client", text: "Сколько стоит?" });
    expect(turns[2]).toMatchObject({ role: "owner", text: "5000" });
  });
});

describe("parseDialogueSource — автоопределение формата", () => {
  it("JSON по содержимому", () => {
    const json = JSON.stringify({
      chat1: { name: "Клиент", messages: { m1: { from_me: true, timestamp: 1767258000, data: "привет" } } }
    });
    const eps = parseDialogueSource(json);
    expect(eps).toHaveLength(1);
    expect(eps[0]!.turns[0]).toMatchObject({ role: "owner", text: "привет" });
  });

  it("txt при обычном тексте", () => {
    const eps = parseDialogueSource("[01.01.2026, 10:00:00] Ильяс: тест", {
      ownerName: "Ильяс",
      filename: "chat.txt"
    });
    expect(eps).toHaveLength(1);
    expect(eps[0]!.turns[0]).toMatchObject({ role: "owner", text: "тест" });
  });
});
