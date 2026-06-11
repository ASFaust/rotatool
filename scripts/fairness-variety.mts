/**
 * Throwaway scenarios for shift-type fairness and variety.
 *
 * Fairness: A already has 3 committed shifts of type "t"; B has none. Two new
 * "t" shifts, both eligible. With fairness ON, both new shifts go to B (keeps
 * the per-type peak at 3 instead of raising A's). OFF → indifferent.
 *
 * Variety: 2 people, types t1/t2, 2 shifts of each (different times), each
 * needing 1, both eligible. With variety ON every person ends up with ≤1 of
 * each type (spread beats repetition). OFF → indifferent.
 *
 * Run: npx tsx scripts/fairness-variety.mts
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

async function solve(data: AppData, start: Date, end: Date) {
  const ctx = buildModel(data, start, end, []);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  return res;
}

// --- Fairness ---------------------------------------------------------------
function fairnessData(enabled: boolean): AppData {
  const priorShifts = [0, 1, 2].map((i) => ({
    id: `h${i}`, name: "Hist", type: "t", start: `2025-12-1${i}T09:00:00`, durationMinutes: 120, status: "committed" as const,
  }));
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [{ id: "att", name: "any", valued: false }],
    persons: [{ id: "A", name: "Ann", activated: true }, { id: "B", name: "Bo", activated: true }],
    personAttributes: [{ personId: "A", attributeId: "att" }, { personId: "B", attributeId: "att" }],
    shiftTemplates: [{ id: "t", name: "T", type: "t", optional: false, activated: true, durationMinutes: 120, activationDateTime: "2026-01-01T09:00:00", frequency: { value: 1, unit: "days" }, placement: "strict" }],
    shiftRequirements: [{ shiftId: "t", attributeId: "att", count: 1 }],
    ledgerShifts: priorShifts,
    ledgerAssignments: priorShifts.map((s) => ({ ledgerShiftId: s.id, personId: "A", status: "committed" as const })),
    solverSettings: { shiftTypeFairness: { enabled, weight: 1 } },
  });
}

for (const enabled of [false, true]) {
  const res = await solve(fairnessData(enabled), new Date("2026-01-01T00:00:00"), new Date("2026-01-03T00:00:00"));
  const aNew = res.assignments.filter((a) => a.personId === "A").length;
  const bNew = res.assignments.filter((a) => a.personId === "B").length;
  console.log(`fairness ${enabled ? "ON " : "OFF"} → A_new=${aNew} B_new=${bNew} (total ${res.assignments.length})`);
}

// --- Variety ----------------------------------------------------------------
function varietyData(enabled: boolean): AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [{ id: "att", name: "any", valued: false }],
    persons: [{ id: "A", name: "Ann", activated: true }, { id: "B", name: "Bo", activated: true }],
    personAttributes: [{ personId: "A", attributeId: "att" }, { personId: "B", attributeId: "att" }],
    shiftTemplates: [
      { id: "t1", name: "T1", type: "t1", optional: false, activated: true, durationMinutes: 120, activationDateTime: "2026-01-01T09:00:00", frequency: { value: 1, unit: "days" }, placement: "strict" },
      { id: "t2", name: "T2", type: "t2", optional: false, activated: true, durationMinutes: 120, activationDateTime: "2026-01-01T14:00:00", frequency: { value: 1, unit: "days" }, placement: "strict" },
    ],
    shiftRequirements: [
      { shiftId: "t1", attributeId: "att", count: 1 },
      { shiftId: "t2", attributeId: "att", count: 1 },
    ],
    solverSettings: { variety: { enabled, weight: 1 } },
  });
}

for (const enabled of [false, true]) {
  const res = await solve(varietyData(enabled), new Date("2026-01-01T00:00:00"), new Date("2026-01-03T00:00:00"));
  // Max same-type count per person.
  const byPersonType = new Map<string, Map<string, number>>();
  const typeOf = new Map(res.shifts.map((s) => [s.instanceId, s.type]));
  for (const a of res.assignments) {
    const m = byPersonType.get(a.personId) ?? byPersonType.set(a.personId, new Map()).get(a.personId)!;
    const ty = typeOf.get(a.instanceId) ?? "?";
    m.set(ty, (m.get(ty) ?? 0) + 1);
  }
  let maxRepeat = 0;
  for (const m of byPersonType.values()) for (const c of m.values()) maxRepeat = Math.max(maxRepeat, c);
  console.log(`variety  ${enabled ? "ON " : "OFF"} → total=${res.assignments.length} maxSameTypePerPerson=${maxRepeat}`);
}
