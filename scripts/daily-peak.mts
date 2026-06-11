/**
 * Scenario for the dailyPeak term ("minimize maximum overtime ratio per day").
 * One day, two non-overlapping 4h shifts, two equal people (no targets → the
 * 8 h/day fallback rate applies). A shift preference makes Alice slightly
 * preferred for everything, so with dailyPeak OFF she gets both shifts (an 8h
 * day, ratio 1.0); ON at weight 3, halving the day's peak ratio to 0.5 saves
 * 1.5 > the 1.0 preference bonus, and the shifts split.
 *
 * Run: npx tsx scripts/daily-peak.mts
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

function data(enabled: boolean): AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    persons: [{ id: "A", name: "Alice" }, { id: "B", name: "Bob" }],
    shiftTemplates: [8, 14].map((h) => ({
      id: `t${h}`, name: `T${h}`, type: "t", optional: false, activated: true,
      durationMinutes: 240, activationDateTime: `2026-01-01T${String(h).padStart(2, "0")}:00:00`,
      frequency: { value: 1, unit: "days" }, placement: "strict",
    })),
    shiftRequirements: [8, 14].map((h) => ({ shiftId: `t${h}`, attributeIds: [], count: 1 })),
    shiftPreferences: [{ personId: "A", shiftType: "", weight: 1 }],
    solverSettings: {
      shiftPreferences: { enabled: true, weight: 1 },
      dailyPeak: { enabled, weight: 3 },
    },
  });
}

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-02T00:00:00");

for (const enabled of [false, true]) {
  const ctx = buildModel(data(enabled), start, end, []);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  const byPerson = new Map<string, number>();
  for (const a of res.assignments) byPerson.set(a.personId, (byPerson.get(a.personId) ?? 0) + 1);
  const counts = ["A", "B"].map((p) => `${p}:${byPerson.get(p) ?? 0}`).join(" ");
  const pass = enabled ? byPerson.get("A") === 1 && byPerson.get("B") === 1 : byPerson.get("A") === 2;
  console.log(`dailyPeak ${enabled ? "ON " : "OFF"} → ${counts} ${pass ? "PASS" : "FAIL"}`);
}
