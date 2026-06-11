/**
 * Bounded solve timings for the ARCHELON example: a few range/settings
 * variants, each with presolve off (current default) vs on, hard-capped via
 * HiGHS time_limit so nothing pins a core for long. Also compares objective
 * values presolve-on vs -off to re-check the 1.14.2 presolve bug.
 *
 * Run: npx tsx scripts/example-archelon-solve.mts
 */
import { EXAMPLES } from "../src/persistence/examples";
import { buildModel } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";
import type { AppData } from "../src/model/types";

const TIME_LIMIT_S = 20;

const base = EXAMPLES.find((e) => e.id === "archelon-rethymno")!.create();

function variant(name: string, tweak: (d: AppData) => void): [string, AppData] {
  const d = structuredClone(base);
  tweak(d);
  return [name, d];
}

const cases: [string, AppData, Date, Date][] = [
  [...variant("3d full", () => {}), new Date("2027-06-01T00:00:00"), new Date("2027-06-04T00:00:00")],
  [...variant("7d coverage only", (d) => (d.solverSettings.fairness.enabled = false)),
    new Date("2027-06-01T00:00:00"), new Date("2027-06-08T00:00:00")],
  [...variant("7d full", () => {}), new Date("2027-06-01T00:00:00"), new Date("2027-06-08T00:00:00")],
  [...variant("30d coverage only", (d) => (d.solverSettings.fairness.enabled = false)),
    new Date("2027-06-01T00:00:00"), new Date("2027-07-01T00:00:00")],
  [...variant("30d full", () => {}), new Date("2027-06-01T00:00:00"), new Date("2027-07-01T00:00:00")],
];

for (const [name, data, start, end] of cases) {
  const ctx = buildModel(data, start, end, []);
  for (const presolve of ["off", "on"]) {
    const t0 = performance.now();
    const sol = await solveLP(ctx.lp, undefined, { presolve, time_limit: TIME_LIMIT_S });
    const ms = (performance.now() - t0).toFixed(0);
    console.log(
      `${name.padEnd(18)} presolve=${presolve.padEnd(3)} status=${sol.Status.padEnd(10)} ` +
        `obj=${sol.ObjectiveValue?.toFixed(2) ?? "?"} time=${ms}ms`,
    );
  }
}
