/**
 * Repro + regression check for the HiGHS 1.14.2 presolve bug (PROGRESS.md
 * gotchas): presolve mis-pins *continuous* auxiliary variables that appear in
 * one constraint + the objective (column singletons), silently returning a
 * sub-optimal solution as "Optimal". It bites both Maximize and Minimize
 * models; `presolve_rule_off` bitmasks don't help. Declaring the aux vars
 * integer/binary dodges it — which is why formulation.ts uses addInteger /
 * addBinary for every auxiliary variable (and counts workload overage in
 * integer minutes instead of fractional hours).
 *
 * Expected output: every "continuous aux" case is WRONG with presolve on,
 * every "integer aux" case is OK.
 *
 * Run: npx tsx scripts/presolve-bug.mts
 */
import { solveLP } from "../src/solver/highs-adapter";

// Case 1 — minimal Maximize shape: max 2x - z, x - z <= 0. Optimum x=1,z=1 → 1.
const maxCont = `Maximize
 obj: 2 x - z
Subject To
 c0: x - z <= 0
Bounds
 0 <= z <= 1
Binary
 x
End`;
const maxInt = maxCont.replace("Binary\n x", "General\n z\nBinary\n x");

// Case 2 — Minimize, the workload-balance shape that failed in practice:
// 4 daily shifts (x), coverage reward per shift, overage var v8 in minutes-like
// units penalized lightly. Optimum: take all 4 → obj -3.4. Buggy: -1.
const minBody = `Subject To
 c0: x0 - f0 >= 0
 c1: x1 - f1 >= 0
 c2: x2 - f2 >= 0
 c3: x3 - f3 >= 0
 c8: 2 x0 + 2 x1 + 2 x2 + 2 x3 - over <= 2
Bounds
 0 <= f0 <= 1
 0 <= f1 <= 1
 0 <= f2 <= 1
 0 <= f3 <= 1
 0 <= over <= 8`;
const minObj = "Minimize\n obj: - f0 - f1 - f2 - f3 + 0.1 over\n";
const minCont = `${minObj}${minBody}\nBinary\n x0 x1 x2 x3\nEnd`;
const minInt = `${minObj}${minBody}\nGeneral\n over\nBinary\n x0 x1 x2 x3\nEnd`;

const cases: [string, string, number][] = [
  ["max, continuous aux", maxCont, 1],
  ["max, integer aux   ", maxInt, 1],
  ["min, continuous aux", minCont, -3.4],
  ["min, integer aux   ", minInt, -3.4],
];

for (const [name, lp, expected] of cases) {
  for (const presolve of ["off", "on"]) {
    const sol = await solveLP(lp, undefined, { presolve });
    const obj = sol.ObjectiveValue ?? NaN;
    const ok = Math.abs(obj - expected) < 1e-6 ? "OK   " : "WRONG";
    console.log(`${name} presolve=${presolve.padEnd(3)} ${ok} status=${sol.Status} obj=${obj} (want ${expected})`);
  }
}
