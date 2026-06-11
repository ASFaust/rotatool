/**
 * Throwaway scenario for the animosity term. One shift needs 2 people; A, B, C
 * all eligible. A and B are an animosity pair. With animosity ON the solver
 * fills the 2 seats without putting A and B together; OFF it may.
 *
 * Run: npx tsx scripts/animosity.mts
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

function data(enabled: boolean): AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [{ id: "att", name: "any", valued: false }],
    persons: ["A", "B", "C"].map((id) => ({ id, name: id, activated: true })),
    personAttributes: ["A", "B", "C"].map((personId) => ({ personId, attributeId: "att" })),
    shiftTemplates: [{ id: "t", name: "T", type: "t", optional: false, activated: true, durationMinutes: 120, activationDateTime: "2026-01-01T09:00:00", frequency: { value: 1, unit: "days" }, placement: "strict" }],
    shiftRequirements: [{ shiftId: "t", attributeId: "att", count: 2 }],
    animosity: [{ personAId: "A", personBId: "B", weight: 1 }],
    solverSettings: { animosity: { enabled, weight: 1 } },
  });
}

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-02T00:00:00");

for (const enabled of [false, true]) {
  const ctx = buildModel(data(enabled), start, end, []);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  const people = res.assignments.map((a) => a.personId).sort();
  const together = people.includes("A") && people.includes("B");
  console.log(`animosity ${enabled ? "ON " : "OFF"} → {${people.join(",")}} A&B together: ${together}`);
}
