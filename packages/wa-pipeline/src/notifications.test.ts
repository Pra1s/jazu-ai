import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendWhatsappOwnerNotification } from "./notifications.js";

// Мокаем глобальный fetch — единственный side effect функции.
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Достаёт { url, body } из первого вызова fetch. */
function firstCall(): { url: string; chatId: string; text: string } {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("expected at least one fetch call");
  const url = String(call[0]);
  const init = call[1] as { body: string };
  const body = JSON.parse(init.body) as { chatId: string; text: string };
  return { url, chatId: body.chatId, text: body.text };
}

describe("sendWhatsappOwnerNotification", () => {
  const base = {
    workerUrl: "http://wa-worker:4001",
    internalToken: "tok",
    agentId: "agent-1",
    text: "Новый лид"
  };

  it("no-op when workerUrl is not configured", async () => {
    await sendWhatsappOwnerNotification({
      ...base,
      workerUrl: undefined,
      personalPhone: "+7 701 123 45 67",
      botPhone: "+7 707 000 00 00"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-op when personal phone has no digits", async () => {
    await sendWhatsappOwnerNotification({
      ...base,
      personalPhone: "—",
      botPhone: "+7 707 000 00 00"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("personal != bot → sends to personal JID", async () => {
    await sendWhatsappOwnerNotification({
      ...base,
      personalPhone: "+7 701 123 45 67",
      botPhone: "+7 707 000 00 00"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, chatId } = firstCall();
    expect(url).toBe("http://wa-worker:4001/connections/agent-1/send");
    expect(chatId).toBe("77011234567@s.whatsapp.net");
  });

  it("personal == bot (different formatting) → sends to self JID", async () => {
    await sendWhatsappOwnerNotification({
      ...base,
      personalPhone: "+7 701 123 45 67",
      botPhone: "77011234567" // тот же номер, другой формат
    });
    const { chatId } = firstCall();
    expect(chatId).toBe("77011234567@s.whatsapp.net");
  });

  it("botPhone null → sends to personal JID", async () => {
    await sendWhatsappOwnerNotification({
      ...base,
      personalPhone: "+7 701 123 45 67",
      botPhone: null
    });
    const { chatId } = firstCall();
    expect(chatId).toBe("77011234567@s.whatsapp.net");
  });

  it("passes internal token header", async () => {
    await sendWhatsappOwnerNotification({
      ...base,
      personalPhone: "+77011234567",
      botPhone: null
    });
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers["x-internal-token"]).toBe("tok");
  });

  it("does NOT throw when worker returns non-2xx", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom") });
    await expect(
      sendWhatsappOwnerNotification({
        ...base,
        personalPhone: "+77011234567",
        botPhone: null
      })
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("does NOT throw when fetch rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      sendWhatsappOwnerNotification({
        ...base,
        personalPhone: "+77011234567",
        botPhone: null
      })
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
