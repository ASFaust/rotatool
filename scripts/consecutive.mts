/**
 * Throwaway scenario for consecutive-same-type avoidance. A daily "night" shift
 * over 3 days, count 1, two eligible people. With the term ON no one works two
 * adjacent nights (the solver alternates); OFF it may stack them on one person.
 *
 * Run: npx tsx scripts/consecutive.mts
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

function data(enabled: boolean): AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [{ id: "att", name: "any", valued: false }],
    persons: ["A", "B"].map((id) => ({ id, name: id, activated: true })),
    personAttributes: ["A", "B"].map((personId) => ({ personId, attributeId: "att" })),
    shiftTemplates: [{ id: "night", name: "Night", type: "night", optional: false, activated: true, durationMinutes: 120, activationDateTime: "2026-01-01T22:00:00", frequency: { value: 1, unit: "days" }, placement: "strict" }],
    shiftRequirements: [{ shiftId: "night", attributeId: "att", count: 1 }],
    solverSettings: { consecutiveSameType: { enabled, weight: 1 } },
  });
}

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-04T00:00:00"); // 3 nights: Jan 1, 2, 3

for (const enabled of [false, true]) {
  const ctx = buildModel(data(enabled), start, end, []);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  const startOf = new Date(0);
  const dayByInstance = new Map(res.shifts.map((s) => [s.instanceId, new Date(s.start).getDate()]));
  // Per person, sorted days; max run of adjacent days.
  const daysByPerson = new Map<string, number[]>();
  for (const a of res.assignments) {
    (daysByPerson.get(a.personId) ?? daysByPerson.set(a.personId, []).get(a.personId)!).push(dayByInstance.get(a.instanceId)!);
  }
  let anyAdjacent = false;
  const dump: string[] = [];
  for (const [p, days] of daysByPerson) {
    const sorted = [...days].sort((x, y) => x - y);
    dump.push(`${p}:[${sorted.join(",")}]`);
    for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] === 1) anyAdjacent = true;
  }
  void startOf;
  console.log(`consecutive ${enabled ? "ON " : "OFF"} → ${dump.join(" ")} adjacentSameNight: ${anyAdjacent}`);
}
