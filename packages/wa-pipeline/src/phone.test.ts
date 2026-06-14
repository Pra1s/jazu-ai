import { describe, it, expect } from "vitest";
import { phoneFromJid, normalizeStatedPhone, resolveLeadPhones } from "./phone.js";

describe("phoneFromJid", () => {
  it("берёт цифры из PN-JID (@s.whatsapp.net)", () => {
    expect(phoneFromJid("77012345678@s.whatsapp.net")).toBe("77012345678");
  });

  it("возвращает null для LID-JID (это не номер)", () => {
    expect(phoneFromJid("277657472258270@lid")).toBeNull();
  });

  it("возвращает null для группового / неизвестного домена", () => {
    expect(phoneFromJid("12345@g.us")).toBeNull();
  });

  it("отбрасывает суффикс устройства, не склеивая цифры", () => {
    expect(phoneFromJid("77012345678:12@s.whatsapp.net")).toBe("77012345678");
  });

  it("возвращает null, если user-part не чистые цифры (не фабрикует)", () => {
    expect(phoneFromJid("user.name@s.whatsapp.net")).toBeNull();
  });

  it("возвращает null для пустого/невалидного", () => {
    expect(phoneFromJid(null)).toBeNull();
    expect(phoneFromJid(undefined)).toBeNull();
    expect(phoneFromJid("@s.whatsapp.net")).toBeNull();
  });
});

describe("normalizeStatedPhone", () => {
  it("оставляет только цифры", () => {
    expect(normalizeStatedPhone("+7 701 234 56 78")).toBe("77012345678");
    expect(normalizeStatedPhone("8(701)234-56-78")).toBe("87012345678");
  });

  it("null для мусора/пустого", () => {
    expect(normalizeStatedPhone("звоните мне")).toBeNull();
    expect(normalizeStatedPhone("")).toBeNull();
    expect(normalizeStatedPhone(null)).toBeNull();
  });
});

describe("resolveLeadPhones", () => {
  it("BUG-кейс: lid-чат без других источников → whatsappPhone=null, а НЕ мусорный lid", () => {
    expect(resolveLeadPhones({ chatId: "277657472258270@lid" }))
      .toEqual({ whatsappPhone: null, contactPhone: null });
  });

  it("PN-чат: whatsappPhone из chatId", () => {
    expect(resolveLeadPhones({ chatId: "77012345678@s.whatsapp.net" }))
      .toEqual({ whatsappPhone: "77012345678", contactPhone: null });
  });

  it("lid-чат: whatsappPhone из senderPhone (резолв воркера), не из lid", () => {
    expect(resolveLeadPhones({ chatId: "277657472258270@lid", senderPhone: "77012345678" }))
      .toEqual({ whatsappPhone: "77012345678", contactPhone: null });
  });

  it("клиент назвал ДРУГОЙ номер → contactPhone отдельно, WA-номер остаётся", () => {
    expect(
      resolveLeadPhones({
        chatId: "77012345678@s.whatsapp.net",
        senderPhone: "77012345678",
        extractedPhone: "+7 702 999 11 22"
      })
    ).toEqual({ whatsappPhone: "77012345678", contactPhone: "77029991122" });
  });

  it("клиент назвал ТОТ ЖЕ номер (те же цифры) → contactPhone null (не дублируем)", () => {
    expect(
      resolveLeadPhones({
        chatId: "77012345678@s.whatsapp.net",
        senderPhone: "77012345678",
        extractedPhone: "+7 701 234 56 78"
      })
    ).toEqual({ whatsappPhone: "77012345678", contactPhone: null });
  });
});
