/**
 * Миграция Б5 (Слой B): пересадка каркасов под контракт v3.
 *
 * Контекст: до v3 Билдер ставил carcass=inspection и ролям support/qualifier
 * (как «разобрать проблему → решить/эскалировать»). В v3 у этих ролей свои
 * каркасы: support→resolution, qualifier→lead_capture. inspection стал
 * override-only (только физические выезды/осмотры у admin/consultant/salesman).
 * Существующие боты с support/qualifier + inspection нужно перевести на новые
 * каркасы, иначе они соберутся со старой механикой осмотра.
 *
 * Правила (только эти, остальное не трогаем):
 *   support   + inspection → resolution
 *   qualifier + inspection → lead_capture
 *   прочие inspection (admin/consultant/salesman) → НЕ трогаем (физический осмотр)
 *
 * Идемпотентность: уже мигрированные (resolution/lead_capture) и физические
 * inspection повторный прогон не меняет.
 *
 * Запуск (DRY-RUN по умолчанию, только показывает план, в БД не пишет):
 *   pnpm --filter @jazu/api exec tsx scripts/migrate-carcass-layer-b.ts
 * Применить (записать в БД):
 *   pnpm --filter @jazu/api exec tsx scripts/migrate-carcass-layer-b.ts --apply
 *
 * ВНИМАНИЕ: НЕ запускать на проде автоматически. Перед продом: прогон на
 * dev/локальной БД → dry-run на копии прод-данных → ручная проверка дамп-лога
 * (особое внимание qualifier+inspection с реальными выездами: после миграции
 * они станут lead_capture и потеряют механику осмотра, такие пометить вручную).
 */
import { fileURLToPath } from "node:url";
import { prisma } from "@jazu/db";

export type CarcassMigrationRow = {
  agentId: string;
  botModel: string | null;
  carcass: string | null;
};

export type CarcassMigrationPlanItem = {
  agentId: string;
  botModel: string | null;
  oldCarcass: string | null;
  newCarcass: string;
};

/**
 * Чистая функция планирования (для теста идемпотентности): по строкам агентов
 * возвращает только те, которым нужна смена каркаса. Уже мигрированные и
 * физические inspection в план не попадают (идемпотентность).
 */
export function planCarcassMigration(rows: CarcassMigrationRow[]): CarcassMigrationPlanItem[] {
  const plan: CarcassMigrationPlanItem[] = [];
  for (const row of rows) {
    if (row.carcass !== "inspection") continue; // трогаем только inspection
    let newCarcass: string | null = null;
    if (row.botModel === "support") newCarcass = "resolution";
    else if (row.botModel === "qualifier") newCarcass = "lead_capture";
    // admin/consultant/salesman + inspection — физический осмотр, не трогаем.
    if (!newCarcass) continue;
    plan.push({
      agentId: row.agentId,
      botModel: row.botModel,
      oldCarcass: row.carcass,
      newCarcass
    });
  }
  return plan;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.agent.findMany({
    where: { carcass: "inspection" },
    select: { id: true, botModel: true, carcass: true }
  });

  const plan = planCarcassMigration(
    rows.map((r) => ({ agentId: r.id, botModel: r.botModel, carcass: r.carcass }))
  );

  console.log(
    `[migrate-carcass] mode=${apply ? "APPLY" : "DRY-RUN"} ` +
    `inspection_rows=${rows.length} to_migrate=${plan.length}`
  );

  // Дамп-лог: что во что переезжает (для ручной проверки перед --apply).
  for (const item of plan) {
    console.log(
      `[migrate-carcass] ${item.agentId}: ${item.botModel ?? "null"}/${item.oldCarcass ?? "null"} → ${item.newCarcass}`
    );
  }

  if (!apply) {
    console.log("[migrate-carcass] DRY-RUN: ничего не записано. Запусти с --apply для применения.");
    return;
  }

  let updated = 0;
  for (const item of plan) {
    await prisma.agent.update({
      where: { id: item.agentId },
      data: { carcass: item.newCarcass }
    });
    updated += 1;
  }

  console.log(`[migrate-carcass] done: updated=${updated}`);
}

// Запускаем main() только при прямом вызове скрипта, не при импорте
// (чтобы тесты могли импортировать planCarcassMigration без коннекта к БД).
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
