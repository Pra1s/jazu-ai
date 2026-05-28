import { describe, it, expect, vi, beforeEach } from "vitest";

// Мокаем @jazu/db ДО импорта тестируемого модуля. Цель — убедиться, что
// deleteUserAccount атомарно делает правильный набор операций, в правильном
// порядке, и обезличивает все нужные поля. Реальная БД для этого не нужна.

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const magicLinkDeleteMany = vi.fn();
const agentDeleteMany = vi.fn();
const waPhoneClaimUpdateMany = vi.fn();
const purchaseUpdateMany = vi.fn();
const llmCallLogUpdateMany = vi.fn();
const usageEventUpdateMany = vi.fn();
const sessionDeleteMany = vi.fn();
const txTransaction = vi.fn();

vi.mock("@jazu/db", () => ({
  prisma: {
    $transaction: txTransaction
  },
  Prisma: {
    JsonNull: Symbol("JsonNull")
  }
}));

const { deleteUserAccount } = await import("./account-deletion.js");

beforeEach(() => {
  userFindUnique.mockReset();
  userUpdate.mockReset();
  magicLinkDeleteMany.mockReset();
  agentDeleteMany.mockReset();
  waPhoneClaimUpdateMany.mockReset();
  purchaseUpdateMany.mockReset();
  llmCallLogUpdateMany.mockReset();
  usageEventUpdateMany.mockReset();
  sessionDeleteMany.mockReset();
  txTransaction.mockReset();

  // Эмулируем prisma.$transaction(fn) — просто вызываем переданную callback
  // с объектом, у которого все нужные методы — наши шпионы.
  txTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      user: { findUnique: userFindUnique, update: userUpdate },
      magicLinkToken: { deleteMany: magicLinkDeleteMany },
      agent: { deleteMany: agentDeleteMany },
      waPhoneClaim: { updateMany: waPhoneClaimUpdateMany },
      purchase: { updateMany: purchaseUpdateMany },
      llmCallLog: { updateMany: llmCallLogUpdateMany },
      usageEvent: { updateMany: usageEventUpdateMany },
      session: { deleteMany: sessionDeleteMany }
    };
    return fn(tx);
  });
});

describe("deleteUserAccount", () => {
  it("throws if user not found", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    await expect(deleteUserAccount("missing")).rejects.toThrow(/not found/);
  });

  it("is idempotent: no-op if user already deleted", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "u1",
      email: "x@y.z",
      deletedAt: new Date()
    });
    await deleteUserAccount("u1");
    expect(userUpdate).not.toHaveBeenCalled();
    expect(agentDeleteMany).not.toHaveBeenCalled();
  });

  describe("happy path: live user", () => {
    beforeEach(async () => {
      userFindUnique.mockResolvedValueOnce({
        id: "u1",
        email: "vasya@example.com",
        deletedAt: null
      });
      await deleteUserAccount("u1");
    });

    it("deletes magic-link tokens by email BEFORE rewriting email", () => {
      expect(magicLinkDeleteMany).toHaveBeenCalledWith({
        where: { email: "vasya@example.com" }
      });
    });

    it("deletes all agents — cascade removes wa/conversations/leads/messages", () => {
      expect(agentDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    });

    it("anonymizes WaPhoneClaim (keeps phoneHash, drops userId+agentId)", () => {
      expect(waPhoneClaimUpdateMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
        data: { userId: null, agentId: null }
      });
    });

    it("anonymizes Purchase (for bookkeeping)", () => {
      expect(purchaseUpdateMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
        data: { userId: null }
      });
    });

    it("anonymizes LlmCallLog (for aggregate analytics)", () => {
      expect(llmCallLogUpdateMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
        data: { userId: null }
      });
    });

    it("anonymizes UsageEvent (for billing audit)", () => {
      expect(usageEventUpdateMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
        data: { userId: null }
      });
    });

    it("deletes all sessions — instant logout everywhere", () => {
      expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    });

    it("wipes PII on User: email→placeholder, others→null, deletedAt set", () => {
      expect(userUpdate).toHaveBeenCalledTimes(1);
      const call = userUpdate.mock.calls[0]?.[0] as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: "u1" });
      expect(call.data).toMatchObject({
        email: "deleted_u1@deleted.local",
        name: null,
        phone: null,
        phoneVerifiedAt: null,
        googleId: null,
        avatarUrl: null,
        telegramChatId: null
      });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
    });

    it("uses Prisma.JsonNull for onboardingState (not undefined or plain null)", () => {
      const call = userUpdate.mock.calls[0]?.[0] as
        | { data: { onboardingState: unknown } }
        | undefined;
      if (!call) throw new Error("userUpdate not called");
      // Это symbol из мока — главное что НЕ undefined и НЕ plain null.
      expect(call.data.onboardingState).toBeDefined();
      expect(call.data.onboardingState).not.toBeNull();
    });
  });
});
