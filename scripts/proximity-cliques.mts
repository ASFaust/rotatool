/** Clique-proximity verification: solver must never double-book, incl. gaps. */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-02T00:00:00");

// 5 hourly-staggered 2h shifts (09,10,11,12,13 → chains of overlaps), 1 person.
// Max non-conflicting picks: 09-11, 11-13(no, 11 starts when 09-11 ends: ok), 13-15 → 3.
function data(gapMinutes: number) {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [],
    persons: [{ id: "A", name: "Alice" }],
    shiftTemplates: [9, 10, 11, 12, 13].map((h) => ({
      id: `t${h}`, name: `T${h}`, type: "t", optional: false, activated: true,
      durationMinutes: 120, activationDateTime: `2026-01-01T${String(h).padStart(2, "0")}:00:00`,
      frequency: { value: 1, unit: "days" }, placement: "strict",
    })),
    shiftRequirements: [9, 10, 11, 12, 13].map((h) => ({ shiftId: `t${h}`, attributeIds: [], count: 1 })),
    solverSettings: { proximityGapMinutes: gapMinutes },
  });
}

for (const [gap, expected] of [[0, 3], [60, 2], [240, 1]] as const) {
  const ctx = buildModel(data(gap), start, end, []);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  const hours = res.assignments
    .map((a) => Number(ctx.instances.find((i) => i.id === a.instanceId)!.start.getHours()))
    .sort((x, y) => x - y);
  // Validate no pair violates the gap.
  let valid = true;
  for (let i = 0; i < hours.length; i++)
    for (let j = i + 1; j < hours.length; j++)
      if ((Math.abs(hours[i] - hours[j]) - 2) * 60 < gap) valid = false;
  const stats = ctx.stats.constraintKinds["proximity"] ?? { count: 0, nonzeros: 0 };
  console.log(
    `gap=${String(gap).padStart(3)}min picked=[${hours.join(",")}] (max ${expected}) ` +
      `valid=${valid} proximityCons=${stats.count} ` +
      (hours.length === expected && valid ? "PASS" : "FAIL"),
  );
}
