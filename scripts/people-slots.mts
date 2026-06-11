/**
 * Throwaway verification for the people-slots formulation.
 * Run: npx tsx scripts/people-slots.mts (from the rotatool dir)
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-02T00:00:00");

function base(extra: Record<string, unknown>): AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    ...extra,
  });
}

async function solve(data: AppData) {
  const ctx = buildModel(data, start, end, []);
  return interpretSolution(await solveLP(ctx.lp), ctx);
}

const template = {
  id: "t", name: "T", type: "t", optional: false, activated: true,
  durationMinutes: 120, activationDateTime: "2026-01-01T09:00:00",
  frequency: { value: 1, unit: "days" }, placement: "strict",
};

// 1. v1 migration shim: old single-attributeId shape still parses.
{
  const d = base({ shiftRequirements: [{ shiftId: "t", attributeId: "a1", count: 2 }] });
  const r = d.shiftRequirements[0];
  console.log("1. v1 shape migrates:", JSON.stringify(r),
    r.attributeIds.length === 1 && r.attributeIds[0] === "a1" && r.required === false ? "PASS" : "FAIL");
}

// 2. AND semantics: slot needs driver ∧ leader. Only Bob has both.
{
  const d = base({
    attributes: [{ id: "drv", name: "driver" }, { id: "ldr", name: "leader" }],
    persons: [{ id: "A", name: "Alice" }, { id: "B", name: "Bob" }],
    personAttributes: [
      { personId: "A", attributeId: "drv" },
      { personId: "B", attributeId: "drv" }, { personId: "B", attributeId: "ldr" },
    ],
    shiftTemplates: [template],
    shiftRequirements: [{ shiftId: "t", attributeIds: ["drv", "ldr"], count: 1 }],
  });
  const res = await solve(d);
  const who = res.assignments.map((a) => a.personId).join(",");
  console.log("2. AND-match picks Bob only:", who, who === "B" ? "PASS" : "FAIL");
}

// 3. No cross-row double-counting: rows [driver ×1] + [leader ×1]; Bob has both
//    attrs, Alice only drives. Both must be assigned (Bob can't fill both rows).
{
  const d = base({
    attributes: [{ id: "drv", name: "driver" }, { id: "ldr", name: "leader" }],
    persons: [{ id: "A", name: "Alice" }, { id: "B", name: "Bob" }],
    personAttributes: [
      { personId: "A", attributeId: "drv" },
      { personId: "B", attributeId: "drv" }, { personId: "B", attributeId: "ldr" },
    ],
    shiftTemplates: [template],
    shiftRequirements: [
      { shiftId: "t", attributeIds: ["drv"], count: 1 },
      { shiftId: "t", attributeIds: ["ldr"], count: 1 },
    ],
  });
  const res = await solve(d);
  const who = res.assignments.map((a) => a.personId).sort().join(",");
  console.log("3. two rows need two people:", who, who === "A,B" ? "PASS" : "FAIL");
}

// 4. Anyone-row + capacity: [leader ×1 required] + [anyone ×1], 3 people.
//    Exactly 2 assigned, leader seat filled.
{
  const d = base({
    attributes: [{ id: "ldr", name: "leader" }],
    persons: [{ id: "A", name: "Alice" }, { id: "B", name: "Bob" }, { id: "C", name: "Cara" }],
    personAttributes: [{ personId: "C", attributeId: "ldr" }],
    shiftTemplates: [template],
    shiftRequirements: [
      { shiftId: "t", attributeIds: ["ldr"], count: 1, required: true },
      { shiftId: "t", attributeIds: [], count: 1 },
    ],
  });
  const res = await solve(d);
  const who = res.assignments.map((a) => a.personId).sort().join(",");
  const ok = res.assignments.length === 2 && who.includes("C");
  console.log("4. leader + anyone, headcount 2 incl. C:", who, ok ? "PASS" : "FAIL");
}

// 5. Required-but-unfillable stays solvable: leader seat required, nobody is a
//    leader. Solver must still return a roster (anyone-seat filled), not error.
{
  const d = base({
    attributes: [{ id: "ldr", name: "leader" }],
    persons: [{ id: "A", name: "Alice" }],
    personAttributes: [],
    shiftTemplates: [template],
    shiftRequirements: [
      { shiftId: "t", attributeIds: ["ldr"], count: 1, required: true },
      { shiftId: "t", attributeIds: [], count: 1 },
    ],
  });
  const res = await solve(d);
  const ok = res.status === "Optimal" && res.assignments.length === 1 && res.assignments[0].personId === "A";
  console.log("5. unfillable required seat degrades softly:", res.status, res.assignments.length, ok ? "PASS" : "FAIL");
}

// 6. Window group + required: weekly strictTime shift, leader only available
//    one day — required seat must steer the chosen day, and unchosen
//    candidates must incur no shortfall.
{
  const d = base({
    attributes: [{ id: "ldr", name: "leader" }],
    persons: [{ id: "A", name: "Alice" }],
    personAttributes: [{ personId: "A", attributeId: "ldr" }],
    availability: [{ personId: "A", kind: "available", start: "2026-01-03", end: "2026-01-03" }],
    shiftTemplates: [{ ...template, frequency: { value: 7, unit: "days" }, placement: "strictTime" }],
    shiftRequirements: [{ shiftId: "t", attributeIds: ["ldr"], count: 1, required: true }],
  });
  const ctx = buildModel(d, start, new Date("2026-01-08T00:00:00"), []);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  const day = res.shifts[0]?.start.slice(0, 10);
  const ok = res.shifts.length === 1 && day === "2026-01-03" && res.assignments.length === 1;
  console.log("6. required seat steers window choice:", day, ok ? "PASS" : "FAIL");
}
