/**
 * Throwaway scenarios: prove the fairness (spread) term works.
 *
 * History: Ann already holds 6h committed inside the range; Bo holds none.
 * Four new 2h shifts, both eligible, no targets (equal shares).
 *   OFF → indifferent split.
 *   ON  → Bo takes (nearly) all new shifts so totals converge.
 *
 * Shares: equal availability, Ann targets 2h/day vs Bo 1h/day → Ann's fair
 * share is 2/3 of the total. Four 2h shifts (8h): ON → Ann 3 shifts, Bo 1.
 *
 * Run: npx tsx scripts/fairness.mts
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-05T00:00:00");

function base(extra: Partial<Record<string, unknown>>): AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [{ id: "att", name: "any", valued: false }],
    personAttributes: [{ personId: "A", attributeId: "att" }, { personId: "B", attributeId: "att" }],
    shiftTemplates: [{
      id: "t", name: "Daily", type: "day", optional: false, activated: true,
      durationMinutes: 120, activationDateTime: "2026-01-01T09:00:00",
      frequency: { value: 1, unit: "days" }, placement: "strict",
    }],
    shiftRequirements: [{ shiftId: "t", attributeId: "att", count: 1 }],
    ...extra,
  });
}

async function solve(data: AppData) {
  // Committed assignments become busy intervals, as generate.ts would pass them.
  const shiftById = new Map(data.ledgerShifts.map((s) => [s.id, s]));
  const busy = data.ledgerAssignments.map((a) => {
    const s = shiftById.get(a.ledgerShiftId)!;
    const t0 = new Date(s.start).getTime();
    return { personId: a.personId, start: t0, end: t0 + s.durationMinutes * 60_000 };
  });
  const ctx = buildModel(data, start, end, busy);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  const count = (pid: string) => res.assignments.filter((a) => a.personId === pid).length;
  return { total: res.assignments.length, a: count("A"), b: count("B") };
}

// --- History: Ann pre-loaded with 6h committed inside the range --------------
const priorShifts = [1, 2, 3].map((i) => ({
  id: `h${i}`, name: "Hist", type: "day", start: `2026-01-0${i}T14:00:00`,
  durationMinutes: 120, status: "committed" as const,
}));
function historyData(enabled: boolean): AppData {
  return base({
    persons: [{ id: "A", name: "Ann", activated: true }, { id: "B", name: "Bo", activated: true }],
    ledgerShifts: priorShifts,
    ledgerAssignments: priorShifts.map((s) => ({ ledgerShiftId: s.id, personId: "A", status: "committed" as const })),
    solverSettings: { fairness: { enabled, weight: 0.1 } },
  });
}

// --- Shares: Ann's target rate is double Bo's --------------------------------
function shareData(enabled: boolean): AppData {
  return base({
    persons: [
      { id: "A", name: "Ann", activated: true, hoursPerTimeframe: { value: 2, unit: "day" } },
      { id: "B", name: "Bo", activated: true, hoursPerTimeframe: { value: 1, unit: "day" } },
    ],
    solverSettings: { fairness: { enabled, weight: 0.1 } },
  });
}

for (const enabled of [false, true]) {
  const r = await solve(historyData(enabled));
  console.log(`history ${enabled ? "ON " : "OFF"} → A_new=${r.a} B_new=${r.b} (total ${r.total}; A holds 6h committed)`);
}
for (const enabled of [false, true]) {
  const r = await solve(shareData(enabled));
  console.log(`shares  ${enabled ? "ON " : "OFF"} → A=${r.a} B=${r.b} (total ${r.total}; A's share 2x B's)`);
}
