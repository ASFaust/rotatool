/**
 * Throwaway scenario for the preferences term. One shift of type "t", both A and
 * B eligible (count 1). Signed preferences decide who gets it:
 *   A avoids t (-1), B prefers t (+1) → B
 *   A prefers t (+1), B avoids t (-1) → A
 * Plus a date-scoped preference that does NOT cover the shift date → no effect.
 *
 * Run: npx tsx scripts/preferences.mts
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

function data(prefs: AppData["preferences"]): AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [{ id: "att", name: "any", valued: false }],
    persons: [{ id: "A", name: "Ann", activated: true }, { id: "B", name: "Bo", activated: true }],
    personAttributes: [{ personId: "A", attributeId: "att" }, { personId: "B", attributeId: "att" }],
    shiftTemplates: [{ id: "t", name: "T", type: "t", optional: false, activated: true, durationMinutes: 120, activationDateTime: "2026-01-01T09:00:00", frequency: { value: 1, unit: "days" }, placement: "strict" }],
    shiftRequirements: [{ shiftId: "t", attributeId: "att", count: 1 }],
    preferences: prefs,
    solverSettings: { preferences: { enabled: true, weight: 1 } },
  });
}

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-02T00:00:00");

async function who(label: string, prefs: AppData["preferences"]) {
  const ctx = buildModel(data(prefs), start, end, []);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  console.log(`${label.padEnd(24)} → ${res.assignments.map((a) => a.personId).join(",") || "(none)"}`);
}

await who("B preferred", [{ personId: "A", shiftType: "t", weight: -1 }, { personId: "B", shiftType: "t", weight: 1 }]);
await who("A preferred", [{ personId: "A", shiftType: "t", weight: 1 }, { personId: "B", shiftType: "t", weight: -1 }]);
// Date-scoped pref that ends before the shift → ignored, falls back to the other pref.
await who("date-scoped (out of range)", [
  { personId: "A", shiftType: "t", weight: 5, dateRangeEnd: "2025-12-31" },
  { personId: "B", shiftType: "t", weight: 1 },
]);
