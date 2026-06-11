/**
 * Size diagnostics for the built-in ARCHELON Rethymno example. Builds the ILP
 * (no solving!) over several ranges and settings variants and prints the model
 * dimensions, to see which terms blow the instance up.
 *
 * Run: npx tsx scripts/example-archelon.mts
 */
import { EXAMPLES } from "../src/persistence/examples";
import { buildModel } from "../src/solver/formulation";
import type { AppData } from "../src/model/types";

const example = EXAMPLES.find((e) => e.id === "archelon-rethymno")!;
const base = example.create();

console.log(
  `dataset: ${base.persons.length} persons, ${base.attributes.length} attributes, ` +
    `${base.shiftTemplates.length} templates, ${base.shiftRequirements.length} requirements`,
);

function variant(name: string, tweak: (d: AppData) => void): [string, AppData] {
  const d = structuredClone(base);
  tweak(d);
  return [name, d];
}

const variants: [string, AppData][] = [
  variant("full (as shipped)", () => {}),
  variant("coverage only", (d) => (d.solverSettings.fairness.enabled = false)),
];

const ranges: [string, Date, Date][] = [
  ["3 days ", new Date("2027-06-01T00:00:00"), new Date("2027-06-04T00:00:00")],
  ["7 days ", new Date("2027-06-01T00:00:00"), new Date("2027-06-08T00:00:00")],
  ["30 days", new Date("2027-06-01T00:00:00"), new Date("2027-07-01T00:00:00")],
];

for (const [rangeName, start, end] of ranges) {
  console.log(`\n== range ${rangeName} ==`);
  for (const [name, data] of variants) {
    const t0 = performance.now();
    const ctx = buildModel(data, start, end, []);
    const ms = (performance.now() - t0).toFixed(0);
    const s = ctx.stats;
    console.log(
      `  ${name.padEnd(24)} inst=${String(ctx.instances.length).padStart(4)} ` +
        `bin=${String(s.binaries).padStart(6)} cont=${String(s.continuous).padStart(6)} ` +
        `cons=${String(s.constraints).padStart(6)} nz=${String(s.nonzeros).padStart(7)} ` +
        `lp=${(ctx.lp.length / 1024).toFixed(0)}KB build=${ms}ms`,
    );
    for (const [kind, k] of Object.entries(s.constraintKinds)) {
      const share = ((100 * k.count) / s.constraints).toFixed(1).padStart(5);
      console.log(
        `      ${kind.padEnd(16)} cons=${String(k.count).padStart(6)} (${share}%) ` +
          `nz=${String(k.nonzeros).padStart(7)} avg-terms=${(k.nonzeros / k.count).toFixed(1)}`,
      );
    }
  }
}
