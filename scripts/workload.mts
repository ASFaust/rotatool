/**
 * Throwaway scenario: prove the workload term changes the chosen assignment.
 * Single eligible person, four daily 2h shifts, target 0.5h/day (2h budget over
 * the 4-day range = room for exactly one shift).
 *
 *   off       → all 4 shifts filled (coverage only)
 *   cap       → hard ceiling: exactly 1 shift filled
 *   balance w=1   → penalty beats coverage past budget: 1 shift
 *   balance w=0.1 → penalty too small: all 4 shifts
 *
 * Run: npx tsx scripts/workload.mts
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

function makeData(workload: AppData["solverSettings"]["workload"]): AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [{ id: "att", name: "any", valued: false }],
    persons: [{ id: "A", name: "Ann", activated: true, hoursPerTimeframe: { value: 0.5, unit: "day" } }],
    personAttributes: [{ personId: "A", attributeId: "att" }],
    shiftTemplates: [{
      id: "t", name: "Daily", type: "day", optional: false, activated: true,
      durationMinutes: 120, activationDateTime: "2026-01-01T09:00:00",
      frequency: { value: 1, unit: "days" }, placement: "strict",
    }],
    shiftRequirements: [{ shiftId: "t", attributeId: "att", count: 1 }],
    solverSettings: { workload },
  });
}

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-05T00:00:00");

async function run(label: string, workload: AppData["solverSettings"]["workload"]) {
  const data = makeData(workload);
  const ctx = buildModel(data, start, end, []);
  const sol = await solveLP(ctx.lp);
  const res = interpretSolution(sol, ctx);
  console.log(`${label.padEnd(16)} status=${res.status} assignments=${res.assignments.length}`);
}

await run("off", { mode: "off", weight: 1 });
await run("cap", { mode: "cap", weight: 1 });
await run("balance w=1", { mode: "balance", weight: 1 });
await run("balance w=0.1", { mode: "balance", weight: 0.1 });
