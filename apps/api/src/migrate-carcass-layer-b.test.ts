import { describe, expect, it } from "vitest";
import { planCarcassMigration, type CarcassMigrationRow } from "../scripts/migrate-carcass-layer-b.js";

describe("planCarcassMigration", () => {
  it("support+inspection → resolution, qualifier+inspection → lead_capture", () => {
    const rows: CarcassMigrationRow[] = [
      { agentId: "a", botModel: "support", carcass: "inspection" },
      { agentId: "b", botModel: "qualifier", carcass: "inspection" }
    ];
    const plan = planCarcassMigration(rows);
    expect(plan).toEqual([
      { agentId: "a", botModel: "support", oldCarcass: "inspection", newCarcass: "resolution" },
      { agentId: "b", botModel: "qualifier", oldCarcass: "inspection", newCarcass: "lead_capture" }
    ]);
  });

  it("физические inspection (admin/consultant/salesman) не трогаются", () => {
    const rows: CarcassMigrationRow[] = [
      { agentId: "a", botModel: "admin", carcass: "inspection" },
      { agentId: "b", botModel: "consultant", carcass: "inspection" },
      { agentId: "c", botModel: "salesman", carcass: "inspection" }
    ];
    expect(planCarcassMigration(rows)).toEqual([]);
  });

  it("не-inspection каркасы не трогаются", () => {
    const rows: CarcassMigrationRow[] = [
      { agentId: "a", botModel: "support", carcass: "resolution" },
      { agentId: "b", botModel: "qualifier", carcass: "lead_capture" },
      { agentId: "c", botModel: "admin", carcass: "booking" },
      { agentId: "d", botModel: "consultant", carcass: "sales" }
    ];
    expect(planCarcassMigration(rows)).toEqual([]);
  });

  it("идемпотентна: повторный прогон плана не даёт новых изменений", () => {
    const rows: CarcassMigrationRow[] = [
      { agentId: "a", botModel: "support", carcass: "inspection" },
      { agentId: "b", botModel: "qualifier", carcass: "inspection" }
    ];
    const firstPlan = planCarcassMigration(rows);
    // Применяем план к строкам (как сделала бы БД).
    const migrated = rows.map((r) => {
      const item = firstPlan.find((p) => p.agentId === r.agentId);
      return item ? { ...r, carcass: item.newCarcass } : r;
    });
    // Второй прогон по уже мигрированным строкам должен быть пустым.
    expect(planCarcassMigration(migrated)).toEqual([]);
  });
});
