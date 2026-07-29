import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job, WaDeliveryJob } from "@jazu/queue";

type UpdateManyArgs = {
  where: { waMessageId: string; index: number };
  data: {
    status: string;
    waMsgId?: string;
    error?: string;
    sentAt?: Date;
  };
};

const updateManyMock = vi.fn<(args: UpdateManyArgs) => Promise<{ count: number }>>();

vi.mock("@jazu/db", () => ({
  prisma: {
    waMessageDelivery: {
      updateMany: updateManyMock
    }
  }
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const { handleWaDelivery } = await import("./wa-delivery.js");

function fakeJob(data: WaDeliveryJob): Job<WaDeliveryJob> {
  return { data } as Job<WaDeliveryJob>;
}

beforeEach(() => {
  updateManyMock.mockReset();
});

describe("handleWaDelivery", () => {
  it("status=sent — обновляет строку, проставляет waMsgId и sentAt", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    await handleWaDelivery(
      fakeJob({ outboundMessageId: "msg-1", index: 0, status: "sent", waMsgId: "3EB0ABC123" })
    );

    const call = updateManyMock.mock.calls[0]![0];
    expect(call.where).toEqual({ waMessageId: "msg-1", index: 0 });
    expect(call.data.status).toBe("sent");
    expect(call.data.waMsgId).toBe("3EB0ABC123");
    expect(call.data.sentAt).toBeInstanceOf(Date);
  });

  it("status=failed — обновляет строку с error, БЕЗ sentAt", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    await handleWaDelivery(
      fakeJob({ outboundMessageId: "msg-1", index: 2, status: "failed", error: "socket generation changed" })
    );

    const call = updateManyMock.mock.calls[0]![0];
    expect(call.where).toEqual({ waMessageId: "msg-1", index: 2 });
    expect(call.data.status).toBe("failed");
    expect(call.data.error).toBe("socket generation changed");
    expect(call.data.sentAt).toBeUndefined();
  });

  it("длинная причина ошибки обрезается до 500 символов", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });
    const longError = "x".repeat(1000);

    await handleWaDelivery(fakeJob({ outboundMessageId: "msg-1", index: 0, status: "failed", error: longError }));

    const call = updateManyMock.mock.calls[0]![0];
    expect(call.data.error).toHaveLength(500);
  });

  it("строка не найдена (count=0) — не бросает, просто логирует", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    await expect(
      handleWaDelivery(fakeJob({ outboundMessageId: "missing", index: 0, status: "sent" }))
    ).resolves.toBeUndefined();
  });
});
