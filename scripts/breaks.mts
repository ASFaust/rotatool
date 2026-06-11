/**
 * Breaks-after-shifts verification: a template's breakMinutes soft-blocks the
 * person after each occurrence; the solver minimizes violated break minutes
 * (weight per hour) instead of going infeasible.
 *
 * 1. steering   — a 0.5 preference pulls P onto shift B; B starts inside P's
 *                 3h break after A. Breaks OFF → P takes B; ON → 2h violation
 *                 (penalty 2 > 0.5) hands B to Q.
 * 2. placement  — anyTime shift B for a lone person avoids the break window
 *                 after A (zero-violation candidate exists, so it's chosen).
 * 3. busy-after — committed busy interval with a break: a candidate starting
 *                 inside it is penalized directly (no z var needed).
 * 4. busy-before— a candidate whose own break runs into a later committed
 *                 shift is penalized too (reverse direction).
 */
import { AppDataSchema, SCHEMA_VERSION } from "../src/model/schema";
import { buildModel, interpretSolution } from "../src/solver/formulation";
import type { BusyInterval } from "../src/solver/formulation";
import { solveLP } from "../src/solver/highs-adapter";

const start = new Date("2026-01-01T00:00:00");
const end = new Date("2026-01-02T00:00:00");

interface Tmpl {
  id: string;
  time: string;
  durationMinutes: number;
  breakMinutes?: number;
  placement?: "strict" | "anyTime";
  attr?: string; // requirement attribute (default: anyone)
}

function data(opts: {
  templates: Tmpl[];
  breaksOn: boolean;
  preferP?: string; // shift type P gets a +0.5 preference for
  onlyP?: boolean;
}) {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [{ id: "lead", name: "lead", valued: false }],
    persons: [{ id: "P", name: "Pia" }, ...(opts.onlyP ? [] : [{ id: "Q", name: "Quentin" }])],
    personAttributes: [{ personId: "P", attributeId: "lead" }],
    shiftTemplates: opts.templates.map((t) => ({
      id: t.id, name: t.id, type: t.id.toLowerCase(), optional: false, activated: true,
      durationMinutes: t.durationMinutes, breakMinutes: t.breakMinutes ?? 0,
      activationDateTime: `2026-01-01T${t.time}:00`,
      frequency: { value: 1, unit: "days" }, placement: t.placement ?? "strict",
      anyTimeGranularity: t.placement === "anyTime" ? { value: 1, unit: "hours" } : undefined,
    })),
    shiftRequirements: opts.templates.map((t) => ({
      shiftId: t.id, attributeIds: t.attr ? [t.attr] : [], count: 1,
    })),
    shiftPreferences: opts.preferP ? [{ personId: "P", shiftType: opts.preferP, weight: 0.5 }] : [],
    solverSettings: {
      shiftPreferences: { enabled: true, weight: 1 },
      breaks: { enabled: opts.breaksOn, weight: 1 },
    },
  });
}

async function solve(d: ReturnType<typeof data>, busy: BusyInterval[] = []) {
  const ctx = buildModel(d, start, end, busy);
  const res = interpretSolution(await solveLP(ctx.lp), ctx);
  const who = (tmpl: string) => {
    const sh = res.shifts.find((s) => s.templateId === tmpl);
    return res.assignments.find((a) => a.instanceId === sh?.instanceId)?.personId ?? "-";
  };
  const startOf = (tmpl: string) => res.shifts.find((s) => s.templateId === tmpl)?.start ?? "-";
  return { res, who, startOf, breakCons: ctx.stats.constraintKinds["break"]?.count ?? 0 };
}

let pass = true;
const check = (label: string, got: string, want: string) => {
  const ok = got === want;
  pass &&= ok;
  console.log(`${label}: got=${got} want=${want} ${ok ? "PASS" : "FAIL"}`);
};

// 1. steering: A 09–12 (lead-only ⇒ P) with 3h break; B 13–15 (anyone), P preferred.
{
  const templates: Tmpl[] = [
    { id: "A", time: "09:00", durationMinutes: 180, breakMinutes: 180, attr: "lead" },
    { id: "B", time: "13:00", durationMinutes: 120 },
  ];
  const off = await solve(data({ templates, breaksOn: false, preferP: "b" }));
  const on = await solve(data({ templates, breaksOn: true, preferP: "b" }));
  check("1a breaks off, preference wins   ", off.who("B"), "P");
  check("1b breaks on, violation outweighs", on.who("B"), "Q");
  console.log(`   (break constraints emitted: off=${off.breakCons}, on=${on.breakCons})`);
}

// 2. placement: lone P; A 08–10 with 4h break (till 14:00); B anyTime 1h.
//    The chosen B candidate must dodge both A itself and A's break window.
{
  const templates: Tmpl[] = [
    { id: "A", time: "08:00", durationMinutes: 120, breakMinutes: 240, attr: "lead" },
    { id: "B", time: "00:00", durationMinutes: 60, placement: "anyTime" },
  ];
  const on = await solve(data({ templates, breaksOn: true, onlyP: true }));
  const bStart = on.startOf("B").slice(11, 16);
  const okSlot = bStart >= "14:00" || bStart <= "07:00";
  pass &&= on.who("B") === "P" && okSlot;
  console.log(`2  anyTime dodges break window  : B@${bStart} by ${on.who("B")} ${on.who("B") === "P" && okSlot ? "PASS" : "FAIL"}`);
}

// 3+4. busy intervals: committed shifts (constants) project breaks both ways.
{
  const h = 3_600_000;
  const t0 = new Date("2026-01-01T00:00:00").getTime();
  // 3: P committed 09–12 with 3h break; B 13–15, P preferred ⇒ Q on breaks.
  const templates3: Tmpl[] = [{ id: "B", time: "13:00", durationMinutes: 120 }];
  const busy3: BusyInterval[] = [{ personId: "P", start: t0 + 9 * h, end: t0 + 12 * h, breakMs: 3 * h }];
  const off3 = await solve(data({ templates: templates3, breaksOn: false, preferP: "b" }), busy3);
  const on3 = await solve(data({ templates: templates3, breaksOn: true, preferP: "b" }), busy3);
  check("3a busy-break off               ", off3.who("B"), "P");
  check("3b busy-break on                ", on3.who("B"), "Q");

  // 4: C 13–15 with 3h break (till 18:00); P committed 16–18 ⇒ C's break would
  //    be cut 2h short for P, so Q gets C despite P's preference.
  const templates4: Tmpl[] = [{ id: "C", time: "13:00", durationMinutes: 120, breakMinutes: 180 }];
  const busy4: BusyInterval[] = [{ personId: "P", start: t0 + 16 * h, end: t0 + 18 * h }];
  const off4 = await solve(data({ templates: templates4, breaksOn: false, preferP: "c" }), busy4);
  const on4 = await solve(data({ templates: templates4, breaksOn: true, preferP: "c" }), busy4);
  check("4a own-break-into-busy off      ", off4.who("C"), "P");
  check("4b own-break-into-busy on       ", on4.who("C"), "Q");
}

console.log(pass ? "ALL PASS" : "SOME FAILED");
process.exit(pass ? 0 : 1);
