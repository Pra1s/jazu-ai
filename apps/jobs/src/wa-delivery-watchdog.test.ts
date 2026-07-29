import { describe, it, expect, vi, beforeEach } from "vitest";

type StaleRow = { id: string; waMessageId: string; index: number; createdAt: Date };
type FindManyArgs = { where: { status: string; createdAt: { lt: Date } }; take: number };

const findManyMock = vi.fn<(args: FindManyArgs) => Promise<StaleRow[]>>();
const captureErrorMock = vi.fn<(err: Error, ctx: { route: string; extra?: Record<string, unknown> }) => void>();

vi.mock("@jazu/db", () => ({
  prisma: {
    waMessageDelivery: {
      findMany: findManyMock
    }
  }
}));

vi.mock("@jazu/observability", () => ({
  captureError: captureErrorMock
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const { checkStaleDeliveries } = await import("./wa-delivery-watchdog.js");

beforeEach(() => {
  findManyMock.mockReset();
  captureErrorMock.mockReset();
});

describe("checkStaleDeliveries", () => {
  it("ничего не найдено — возвращает 0, captureError не зовётся", async () => {
    findManyMock.mockResolvedValue([]);

    const count = await checkStaleDeliveries(15 * 60_000);

    expect(count).toBe(0);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("запрашивает status=pending и createdAt старше порога", async () => {
    findManyMock.mockResolvedValue([]);
    const before = Date.now();

    await checkStaleDeliveries(15 * 60_000);

    const call = findManyMock.mock.calls[0]![0];
    expect(call.where.status).toBe("pending");
    const cutoff = call.where.createdAt.lt;
    // cutoff ≈ now - 15 мин, с запасом на выполнение теста.
    expect(cutoff.getTime()).toBeLessThanOrEqual(before - 15 * 60_000 + 1000);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 15 * 60_000 - 5000);
  });

  it("есть зависшие доставки — возвращает их число и репортит в captureError", async () => {
    const stale: StaleRow[] = [
      { id: "d1", waMessageId: "m1", index: 0, createdAt: new Date(Date.now() - 20 * 60_000) },
      { id: "d2", waMessageId: "m1", index: 1, createdAt: new Date(Date.now() - 25 * 60_000) }
    ];
    findManyMock.mockResolvedValue(stale);

    const count = await checkStaleDeliveries(15 * 60_000);

    expect(count).toBe(2);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureErrorMock.mock.calls[0]!;
    expect(err.message).toContain("2");
    expect(ctx.route).toBe("jobs:wa-delivery-watchdog");
  });
});
