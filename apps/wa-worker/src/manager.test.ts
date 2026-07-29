import { describe, it, expect } from "vitest";
import { assertSameGeneration, StaleSocketError, type ManagedConnection } from "./manager.js";

// Полноценный тест реконнекта посреди отправки нужен с живым Baileys-сокетом
// (см. mighty-meandering-sutton.md, раздел «Проверка»). Здесь — сама логика
// сравнения поколений, вынесенная из sendUnlocked ради юнит-теста.
function fakeConnection(overrides: Partial<ManagedConnection> = {}): ManagedConnection {
  return {
    agentId: "agent-1",
    socket: {} as NonNullable<ManagedConnection["socket"]>,
    status: "connected",
    workerSessionId: "session-1",
    stopRequested: false,
    lastSentAt: new Map(),
    selfSentIds: new Set(),
    generation: 1,
    reconnectAttempts: 0,
    styleHistoryCapture: false,
    pairingMode: false,
    ...overrides
  };
}

/**
 * exactOptionalPropertyTypes запрещает явный `socket: undefined` в типизированном
 * литерале — воспроизводим рантайм-случай "сокета нет" удалением поля из клона.
 */
function withoutSocket(conn: ManagedConnection): ManagedConnection {
  const clone: Record<string, unknown> = { ...conn };
  delete clone.socket;
  return clone as ManagedConnection;
}

describe("assertSameGeneration", () => {
  it("не бросает, когда поколение совпадает и сокет жив", () => {
    const conn = fakeConnection({ generation: 3 });
    expect(() => assertSameGeneration(conn, 3, "agent/chat")).not.toThrow();
  });

  it("бросает StaleSocketError, когда поколение сменилось (реконнект)", () => {
    // Именно этот случай ломал доставку до фикса: sendUnlocked захватывал
    // generation в начале отправки, а start() тем временем подменял ManagedConnection
    // целиком на новое поколение — остаток пузырей уходил в мёртвый сокет молча.
    const conn = fakeConnection({ generation: 2 });
    expect(() => assertSameGeneration(conn, 1, "agent/chat")).toThrow(StaleSocketError);
  });

  it("бросает StaleSocketError, когда соединения больше нет", () => {
    expect(() => assertSameGeneration(undefined, 1, "agent/chat")).toThrow(StaleSocketError);
  });

  it("бросает StaleSocketError, когда соединение есть, но сокет уже отсутствует", () => {
    const conn = withoutSocket(fakeConnection({ generation: 1 }));
    expect(() => assertSameGeneration(conn, 1, "agent/chat")).toThrow(StaleSocketError);
  });

  it("сообщение об ошибке называет оба поколения — старое и текущее", () => {
    const conn = fakeConnection({ generation: 5 });
    try {
      assertSameGeneration(conn, 2, "agent-42/79001234567@s.whatsapp.net");
      expect.unreachable("assertSameGeneration должна была бросить");
    } catch (err) {
      expect(err).toBeInstanceOf(StaleSocketError);
      expect((err as Error).message).toContain("agent-42/79001234567@s.whatsapp.net");
      expect((err as Error).message).toContain("2");
      expect((err as Error).message).toContain("5");
    }
  });
});
