/**
 * formulation.ts — turn the dataset + a date range into an LP model, and
 * interpret the solver's answer back into chosen shifts + assignments.
 *
 * Pure (no Web Worker), so it is unit-testable in Node. The worker-driven
 * orchestration lives in generate.ts.
 *
 * Decision variables (v2):
 *  - x[person, instance] binary — person works that occurrence.
 *  - y[person, row] binary per people-slot row the person qualifies for
 *    (holds *all* of the row's attributes). x = Σ_rows y, so each person
 *    occupies exactly one row and can never be double-counted across rows.
 *    When a person matches a single row, x doubles as that y (no extra var).
 *  - slot[instance] binary, one per candidate in a strictTime/anyTime window
 *    group; exactly one candidate per group is chosen, and x ≤ slot links them.
 *  - h[person, day] integer minute subtotals feeding all hour-based terms
 *    (workload, fairness, daily peak), keeping their rows sparse.
 *
 * Hard constraints: availability (ineligible person ⇒ no variable), proximity
 * (pairwise mutual exclusion within a gap), window-selection (one slot per
 * group), per-row seat capacity (Σ y ≤ count). Workload in `cap` mode adds a
 * per-person hard hours ceiling.
 *
 * Objective: a weighted sum the user configures in SolverSettings. Coverage is
 * the positive base — reward each occupied seat, so an understaffed roster
 * degrades instead of becoming infeasible. Rows flagged `required` add a heavy
 * shortfall penalty per empty seat (soft, so the solver still returns a roster
 * the UI can flag, rather than reporting bare infeasibility). Other terms
 * (workload balance, …) add penalties that subtract.
 */

import { LpBuilder } from "./builder";
import type { HighsLikeSolution, LpStats } from "./builder";
import { expandAll } from "../model/expand";
import { isPersonAvailable } from "../model/ledger";
import type { AppData, ShiftInstance } from "../model/types";

export interface GeneratedShift {
  instanceId: string;
  templateId: string;
  name: string;
  type: string;
  start: string; // local ISO datetime
  durationMinutes: number;
}

export interface GeneratedAssignment {
  instanceId: string;
  personId: string;
}

export interface GenerateResult {
  status: string;
  shifts: GeneratedShift[];
  assignments: GeneratedAssignment[];
  instancesConsidered: number;
}

/** Everything needed to turn a HiGHS solution back into shifts + assignments. */
export interface ModelContext {
  lp: string;
  /** ILP size counters — log these to gauge solve difficulty before solving. */
  stats: LpStats;
  data: AppData;
  instances: ShiftInstance[];
  /** x variable name -> (person, instance). */
  xVars: Map<string, { personId: string; instanceId: string }>;
  /** instance id -> slot variable name (only for grouped instances). */
  slotVar: Map<string, string>;
}

const pad = (n: number) => String(n).padStart(2, "0");
function fmtLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Two occurrences conflict if they overlap or fall within `gapMs` of each other. */
function inProximity(aStart: number, aEnd: number, bStart: number, bEnd: number, gapMs: number): boolean {
  const latestStart = Math.max(aStart, bStart);
  const earliestEnd = Math.min(aEnd, bEnd);
  if (latestStart < earliestEnd) return true; // overlap
  return latestStart - earliestEnd < gapMs; // gap below threshold
}

/** A person already occupied in a time window (committed/performed elsewhere). */
export interface BusyInterval {
  personId: string;
  start: number;
  end: number;
  /** Rest period after `end`, in ms (from the source template's break). */
  breakMs?: number;
}

/**
 * A person's workload target normalized to a generation range, in hours. The
 * `hoursPerTimeframe` is a rate (e.g. 40h/week); scaled by the range length it
 * yields the hours budget for this particular generation window.
 */
function targetHoursForRange(
  hpt: { value: number; unit: "day" | "week" | "month" },
  rangeMs: number,
): number {
  return dailyRate(hpt) * (rangeMs / 86_400_000);
}

/** A person's hours-per-timeframe target expressed as hours per day. */
function dailyRate(hpt: { value: number; unit: "day" | "week" | "month" }): number {
  return hpt.value / (hpt.unit === "day" ? 1 : hpt.unit === "week" ? 7 : 30);
}

/** Days within [rangeStart, rangeEnd) on which the person is available. */
function availableDays(data: AppData, personId: string, rangeStart: Date, rangeEnd: Date): number {
  let n = 0;
  for (const d = new Date(rangeStart); d < rangeEnd; d.setDate(d.getDate() + 1)) {
    if (isPersonAvailable(data, personId, d)) n++;
  }
  return n;
}


/** Build the LP model for generating a roster over [rangeStart, rangeEnd). */
export function buildModel(
  data: AppData,
  rangeStart: Date,
  rangeEnd: Date,
  busy: BusyInterval[] = [],
): ModelContext {
  const b = new LpBuilder();
  const instances = expandAll(data, rangeStart, rangeEnd);

  // Busy windows per person, so generation never double-books a locked person.
  const busyByPerson = new Map<string, BusyInterval[]>();
  for (const iv of busy) {
    (busyByPerson.get(iv.personId) ?? busyByPerson.set(iv.personId, []).get(iv.personId)!).push(iv);
  }

  // Person -> set of attribute ids (for requirement matching), activated only.
  const attrsByPerson = new Map<string, Set<string>>();
  for (const p of data.persons) {
    if (p.activated) attrsByPerson.set(p.id, new Set());
  }
  for (const pa of data.personAttributes) {
    attrsByPerson.get(pa.personId)?.add(pa.attributeId);
  }

  const xVars = new Map<string, { personId: string; instanceId: string }>();
  // instance id -> map(personId -> x var name), for building constraints.
  const xByInstance = new Map<string, Map<string, string>>();
  const slotVar = new Map<string, string>();
  const coverage: [string, number][] = [];
  // Secondary objective terms (workload/fairness/variety/preference bonuses and
  // signed preference bonuses) accumulate here and are added onto coverage in the
  // final maximize objective. Penalties carry negative coefficients.
  const penalties: [string, number][] = [];
  const coverageWeight = data.solverSettings.coverage.enabled ? data.solverSettings.coverage.weight : 0;
  // Per empty seat in a `required` row. Soft but dominant, so one unfillable
  // seat degrades the roster (and gets flagged) instead of making it infeasible.
  const requiredWeight = 1000 * Math.max(1, coverageWeight);
  const gapMs = data.solverSettings.proximityGapMinutes * 60_000;

  // Window-selection groups first: exactly one candidate per group. The slot
  // vars must exist before the instance loop so x-linking and required-seat
  // shortfalls (which only apply to the chosen candidate) can reference them.
  const groups = new Map<string, ShiftInstance[]>();
  for (const inst of instances) {
    if (inst.windowGroupId) {
      (groups.get(inst.windowGroupId) ?? groups.set(inst.windowGroupId, []).get(inst.windowGroupId)!).push(inst);
    }
  }
  for (const [, members] of groups) {
    const slots: [string, number][] = [];
    for (const inst of members) {
      const slot = b.addBinary();
      slotVar.set(inst.id, slot);
      slots.push([slot, 1]);
    }
    b.addConstraint(slots, "=", 1, "window-select");
  }

  for (const inst of instances) {
    const slot = slotVar.get(inst.id);

    // Eligible people: activated, available at the start, and qualifying for a
    // row — holding *all* its attributes (or any row, if the instance has no
    // rows at all). rowSeats[r] collects the seat vars counting toward row r.
    const xMap = new Map<string, string>();
    const rowSeats: string[][] = inst.requirements.map(() => []);
    const instS = inst.start.getTime();
    const instE = inst.end.getTime();
    for (const [personId, attrs] of attrsByPerson) {
      if (!isPersonAvailable(data, personId, inst.start)) continue;
      const matchRows = inst.requirements
        .map((_, ri) => ri)
        .filter((ri) => inst.requirements[ri].attributeIds.every((a) => attrs.has(a)));
      if (inst.requirements.length > 0 && matchRows.length === 0) continue;
      // Skip if this person is already busy (committed/performed) at this time.
      const conflicts = busyByPerson.get(personId)?.some((iv) => inProximity(instS, instE, iv.start, iv.end, gapMs));
      if (conflicts) continue;
      const x = b.addBinary();
      xMap.set(personId, x);
      xVars.set(x, { personId, instanceId: inst.id });
      if (matchRows.length === 1) {
        rowSeats[matchRows[0]].push(x); // x doubles as the seat var
      } else if (matchRows.length > 1) {
        // One seat var per qualifying row; x = Σ y picks (at most) one row.
        const ys = matchRows.map(() => b.addBinary());
        matchRows.forEach((ri, k) => rowSeats[ri].push(ys[k]));
        b.addConstraint([[x, 1], ...ys.map((y): [string, number] => [y, -1])], "=", 0, "row-pick");
      }
      // Link: assignment on a window candidate requires its slot to be chosen.
      if (slot) b.addConstraint([[x, 1], [slot, -1]], "<=", 0, "slot-link");
    }
    xByInstance.set(inst.id, xMap);

    // Per row: seat capacity, coverage reward per occupied seat, and the
    // required-row shortfall (gated on the slot for window candidates, so
    // unchosen candidates incur none).
    inst.requirements.forEach((req, ri) => {
      const seats = rowSeats[ri];
      if (seats.length > 0) {
        b.addConstraint(seats.map((v): [string, number] => [v, 1]), "<=", req.count, "row-capacity");
        if (coverageWeight > 0) for (const v of seats) coverage.push([v, coverageWeight]);
      }
      if (req.required) {
        // short >= count·(slot or 1) - Σ seats. Integer, not continuous — see
        // the warning on addContinuous.
        const short = b.addInteger(0, req.count);
        const seatTerms = seats.map((v): [string, number] => [v, -1]);
        if (slot) {
          b.addConstraint([[slot, req.count], ...seatTerms, [short, -1]], "<=", 0, "required-short");
        } else {
          b.addConstraint([...seatTerms, [short, -1]], "<=", -req.count, "required-short");
        }
        penalties.push([short, -requiredWeight]);
      }
    });
  }

  // Proximity: per person, mutually exclude conflicting occurrences. With a gap
  // of 0 this still forbids genuine overlaps.
  //
  // Inflating every occurrence by gap/2 turns "conflict" into plain interval
  // overlap, so each person's conflict graph is an interval graph. Instead of
  // one constraint per conflicting *pair* (quadratic in simultaneous shifts —
  // the dominant constraint kind by far), emit one Σx ≤ 1 per *maximal clique*:
  // a left-to-right sweep yields at most one clique per occurrence, and clique
  // constraints dominate the pairwise ones (every conflicting pair shares a
  // clique) while giving a tighter LP relaxation.
  const spanById = new Map(
    instances.map((i) => [
      i.id,
      { s: i.start.getTime(), e: i.end.getTime(), breakMs: i.breakMinutes * 60_000, group: i.windowGroupId },
    ]),
  );
  const instancesByPerson = new Map<string, string[]>();
  for (const ref of xVars.values()) {
    (instancesByPerson.get(ref.personId) ?? instancesByPerson.set(ref.personId, []).get(ref.personId)!).push(ref.instanceId);
  }
  for (const [personId, instIds] of instancesByPerson) {
    const ivs = instIds
      .map((iid) => {
        const sp = spanById.get(iid)!;
        return { v: xByInstance.get(iid)!.get(personId)!, s: sp.s - gapMs / 2, e: sp.e + gapMs / 2 };
      })
      .sort((a, b) => a.s - b.s || a.e - b.e);

    const emit = (clique: typeof ivs) => {
      if (clique.length >= 2) {
        b.addConstraint(clique.map((iv): [string, number] => [iv.v, 1]), "<=", 1, "proximity");
      }
    };
    // Active set = intervals containing the sweep point. It is a maximal clique
    // exactly when the next arrival first expires members (or input ends) after
    // at least one arrival grew it.
    let active: typeof ivs = [];
    let grown = false;
    for (const iv of ivs) {
      // Strict overlap test (matches inProximity): expired iff e <= next start.
      if (active.some((a) => a.e <= iv.s)) {
        if (grown) emit(active);
        active = active.filter((a) => a.e > iv.s);
        grown = false;
      }
      active.push(iv);
      grown = true;
    }
    if (grown) emit(active);
  }

  // Breaks: a template's breakMinutes declares a rest period after each
  // occurrence. It doesn't count as worked time, but the same person starting
  // another shift inside it costs the violated minutes — soft blocking, so the
  // solver pays a configurable price instead of going infeasible when nothing
  // else works (e.g. "no morning survey after the late-night presentation",
  // or a short break after kiosk so consecutive kiosk shifts are discouraged).
  // Pairs already excluded hard (overlap / proximity gap / same window group)
  // are skipped. Per (person, break) one aux var carries the violated minutes:
  // viol >= min_c·(x_a + x_c - 1) for every follower c starting inside the
  // break — so several followers in one break cost the *worst* cut (the break
  // effectively ended at the earliest violating start), and the var count
  // stays at one per break instead of one per pair (pairwise binaries made
  // breaks >half of the ARCHELON 30d model). Against committed/performed busy
  // intervals (x fixed at 1) the penalty lands on the candidate var directly,
  // in both directions (their break onto it, its break onto them).
  const breaks = data.solverSettings.breaks;
  if (breaks.enabled && breaks.weight > 0) {
    const perMinute = breaks.weight / 60; // weight is per violated hour
    for (const [personId, instIds] of instancesByPerson) {
      const cands = instIds
        .map((iid) => {
          const sp = spanById.get(iid)!;
          return { v: xByInstance.get(iid)!.get(personId)!, ...sp };
        })
        .sort((a, b) => a.s - b.s || a.e - b.e);

      for (const a of cands) {
        if (a.breakMs <= 0) continue;
        const restEnd = a.e + a.breakMs;
        const followers: { v: string; min: number }[] = [];
        for (const c of cands) {
          if (c.s >= restEnd) break; // sorted by start: no later violator either
          if (c === a || c.s - a.e < gapMs) continue; // overlap/gap ⇒ hard-excluded
          if (a.group !== undefined && a.group === c.group) continue; // mutually exclusive
          followers.push({ v: c.v, min: (restEnd - c.s) / 60_000 });
        }
        if (followers.length === 0) continue;
        // With one follower the aux would be a continuous column singleton in
        // the objective — the presolve bug's exact shape (see addContinuous) —
        // so that case uses a binary z (= the pair indicator) instead.
        if (followers.length === 1) {
          const f = followers[0];
          const z = b.addBinary();
          b.addConstraint([[a.v, 1], [f.v, 1], [z, -1]], "<=", 1, "break"); // z >= x_a + x_c - 1
          penalties.push([z, -perMinute * f.min]);
        } else {
          const viol = b.addContinuous(0, Math.max(...followers.map((f) => f.min)));
          for (const f of followers) {
            b.addConstraint([[a.v, f.min], [f.v, f.min], [viol, -1]], "<=", f.min, "break");
          }
          penalties.push([viol, -perMinute]);
        }
      }

      // Fixed busy intervals: candidates conflicting hard with one never got a
      // var, so anything here is a pure break-time violation.
      for (const iv of busyByPerson.get(personId) ?? []) {
        const ivBreakEnd = iv.end + (iv.breakMs ?? 0);
        for (const c of cands) {
          let violMin = 0;
          if (c.s >= iv.end && c.s < ivBreakEnd) violMin += (ivBreakEnd - c.s) / 60_000;
          if (iv.start >= c.e && iv.start < c.e + c.breakMs) violMin += (c.e + c.breakMs - iv.start) / 60_000;
          if (violMin > 0) penalties.push([c.v, -perMinute * violMin]);
        }
      }
    }
  }

  // Workload, fairness and daily peak all account hours: committed/performed
  // history inside the range (constants) plus newly generated assignments (LP
  // terms). They share a *day-subtotal layer*: one integer var h[p,d] = new
  // minutes person p works on day d, defined by a short row over that day's
  // candidate vars. Every downstream row then references the few h vars it
  // needs instead of a person's hundreds of candidate vars — the dense
  // fairness rows were the solver's main bottleneck on month ranges.
  const workload = data.solverSettings.workload;
  const fairness = data.solverSettings.fairness;
  const dailyPeak = data.solverSettings.dailyPeak;
  const fairnessOn = fairness.enabled && fairness.weight > 0;
  const dailyPeakOn = dailyPeak.enabled && dailyPeak.weight > 0;
  if (workload.mode !== "off" || fairnessOn || dailyPeakOn) {
    const rangeMs = rangeEnd.getTime() - rangeStart.getTime();
    const rs = rangeStart.getTime();
    const re = rangeEnd.getTime();

    // Enumerate the range's calendar days (occurrences belong to their start's
    // local day; calendar stepping keeps this DST-safe).
    const dayOf = (d: Date) => fmtLocalDateTime(d).slice(0, 10);
    const dayOrd = new Map<string, number>();
    const dayDates: Date[] = [];
    for (const d = new Date(rangeStart); d < rangeEnd; d.setDate(d.getDate() + 1)) {
      dayOrd.set(dayOf(d), dayDates.length);
      dayDates.push(new Date(d));
    }
    const numDays = dayDates.length;

    // Committed/performed minutes per person per day (constants).
    const constMin = new Map<string, number[]>();
    const constRow = (pid: string) => constMin.get(pid) ?? constMin.set(pid, new Array(numDays).fill(0)).get(pid)!;
    for (const iv of busy) {
      if (iv.start < rs || iv.start >= re) continue;
      const ord = dayOrd.get(dayOf(new Date(iv.start)));
      if (ord !== undefined) constRow(iv.personId)[ord] += Math.round((iv.end - iv.start) / 60_000);
    }

    // Candidate minutes per (person, day) as LP terms.
    const dayTerms = new Map<string, Map<number, [string, number][]>>();
    for (const inst of instances) {
      const ord = dayOrd.get(dayOf(inst.start));
      if (ord === undefined) continue;
      const minutes = Math.round((inst.end.getTime() - inst.start.getTime()) / 60_000);
      for (const [personId, v] of xByInstance.get(inst.id)!) {
        const perDay = dayTerms.get(personId) ?? dayTerms.set(personId, new Map()).get(personId)!;
        (perDay.get(ord) ?? perDay.set(ord, []).get(ord)!).push([v, minutes]);
      }
    }

    // h[p,d] minute subtotals (sparse: only where candidates exist).
    // Continuous on purpose: equality-pinned to a sum of integers (so integral
    // anyway), never in the objective, and always in ≥2 rows — outside the
    // HiGHS column-singleton presolve bug (see addContinuous). Declaring the
    // layer integer instead hands the brancher ~persons×days bogus candidates
    // and stalls incumbent finding on month ranges.
    const hVar = new Map<string, Map<number, { v: string; ub: number }>>();
    for (const [personId, perDay] of dayTerms) {
      const hs = new Map<number, { v: string; ub: number }>();
      for (const [ord, terms] of perDay) {
        const ub = terms.reduce((s, [, m]) => s + m, 0);
        const h = b.addContinuous(0, ub);
        b.addConstraint([[h, 1], ...terms.map(([v, m]): [string, number] => [v, -m])], "=", 0, "day-hours");
        hs.set(ord, { v: h, ub });
      }
      hVar.set(personId, hs);
    }
    const hTermsFor = (pid: string, fromOrd = 0, toOrd = numDays): [string, number][] =>
      [...(hVar.get(pid) ?? [])].filter(([ord]) => ord >= fromOrd && ord < toOrd).map(([, h]): [string, number] => [h.v, 1]);
    /** Max possible new minutes for a person over [fromOrd, toOrd) — for aux var bounds. */
    const hUbFor = (pid: string, fromOrd = 0, toOrd = numDays): number =>
      [...(hVar.get(pid) ?? [])].reduce((s, [ord, h]) => (ord >= fromOrd && ord < toOrd ? s + h.ub : s), 0);
    const constMinFor = (pid: string, fromOrd = 0, toOrd = numDays): number =>
      (constMin.get(pid) ?? []).reduce((s, m, ord) => (ord >= fromOrd && ord < toOrd ? s + m : s), 0);

    // Daily rate per person: the target where set, else the mean target. The
    // fallback when *nobody* has a target differs by use: fairness only needs
    // relative shares (1 is fine), but daily-peak ratios are absolute — there
    // an 8 h/day standard workday keeps the term's scale sane vs coverage.
    const rates = data.persons
      .filter((p) => attrsByPerson.has(p.id) && p.hoursPerTimeframe)
      .map((p) => dailyRate(p.hoursPerTimeframe!));
    const meanRate = rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : 1;
    const peakFallback = rates.length > 0 ? meanRate : 8;
    const rateMin = (p: { hoursPerTimeframe?: { value: number; unit: "day" | "week" | "month" } }) =>
      Math.max(1, Math.round((p.hoursPerTimeframe ? dailyRate(p.hoursPerTimeframe) : peakFallback) * 60));

    // Workload: count hours against the person's absolute per-timeframe
    // target. `cap` is a hard ceiling; `balance` softly penalizes minutes
    // above target so load spreads.
    if (workload.mode !== "off") {
      for (const p of data.persons) {
        if (!p.hoursPerTimeframe) continue; // no target ⇒ unconstrained
        const terms = hTermsFor(p.id);
        if (terms.length === 0) continue;
        const budgetMin = Math.max(
          0,
          Math.round((targetHoursForRange(p.hoursPerTimeframe, rangeMs) - constMinFor(p.id) / 60) * 60),
        );
        if (workload.mode === "cap") {
          b.addConstraint(terms, "<=", budgetMin, "workload-cap");
        } else if (workload.weight > 0) {
          // over >= sum(new minutes) - budget; penalize (weight stays per-hour).
          const maxMinutes = [...hVar.get(p.id)!.values()].reduce((s, h) => s + h.ub, 0);
          const over = b.addInteger(0, maxMinutes);
          b.addConstraint([...terms, [over, -1]], "<=", budgetMin, "workload-over");
          penalties.push([over, -workload.weight / 60]);
        }
      }
    }

    // Fairness: penalize each person's L1 deviation from their fair share of
    // the total minutes assigned per *interval* (default a week; 0 = the whole
    // range). Unlike workload-balance the reference point is relative —
    // whatever demand exists, split across whoever is around. Shares are
    // weighted by days available in the interval (a half-stay owes half a
    // share) and by the person's daily rate, so e.g. leaders with a higher
    // target carry proportionally more. Balancing per interval stops totals
    // from being evened out by front-loading someone's whole share.
    if (fairnessOn) {
      const intervalLen = fairness.intervalDays > 0 ? fairness.intervalDays : numDays;
      for (let fromOrd = 0; fromOrd < numDays; fromOrd += intervalLen) {
        const toOrd = Math.min(fromOrd + intervalLen, numDays);
        const intervalStart = dayDates[fromOrd];
        const intervalEnd = toOrd < numDays ? dayDates[toOrd] : rangeEnd;

        interface Participant {
          weight: number;
          terms: [string, number][];
          constMinutes: number;
          maxMinutes: number;
        }
        const participants: Participant[] = [];
        for (const p of data.persons) {
          if (!attrsByPerson.has(p.id)) continue;
          const terms = hTermsFor(p.id, fromOrd, toOrd);
          const constMinutes = constMinFor(p.id, fromOrd, toOrd);
          // Someone who can hold no minutes in the interval has nothing to
          // balance; including them would only penalize assigning at all.
          if (terms.length === 0 && constMinutes === 0) continue;
          const weight =
            availableDays(data, p.id, intervalStart, intervalEnd) *
            (p.hoursPerTimeframe ? dailyRate(p.hoursPerTimeframe) : meanRate);
          if (weight <= 0) continue;
          participants.push({ weight, terms, constMinutes, maxMinutes: constMinutes + hUbFor(p.id, fromOrd, toOrd) });
        }
        if (participants.length < 2) continue;

        const totalWeight = participants.reduce((s, p) => s + p.weight, 0);
        const totalConst = participants.reduce((s, p) => s + p.constMinutes, 0);
        const maxTotal = participants.reduce((s, p) => s + p.maxMinutes, 0);

        // total = all participants' minutes (committed constants + new vars).
        // Continuous: equality-defined over h vars, in 1+2·participants rows,
        // not in the objective — safe from the presolve singleton bug.
        const total = b.addContinuous(0, maxTotal);
        b.addConstraint(
          [[total, 1], ...participants.flatMap((p) => p.terms.map(([v]): [string, number] => [v, -1]))],
          "=",
          totalConst,
          "fairness-total",
        );

        for (const p of participants) {
          const share = p.weight / totalWeight;
          // dev >= |load_p - share·total| with load_p = constMinutes + new.
          // Continuous: appears in two rows + objective, not a singleton.
          const dev = b.addContinuous(0, maxTotal);
          b.addConstraint([...p.terms, [total, -share], [dev, -1]], "<=", -p.constMinutes, "fairness-dev");
          b.addConstraint([[total, share], ...p.terms.map(([v]): [string, number] => [v, -1]), [dev, -1]], "<=", p.constMinutes, "fairness-dev");
          penalties.push([dev, -fairness.weight / 60]);
        }
      }
    }

    // Daily peak: per day, penalize the *maximum overtime ratio* across people
    // — assigned minutes relative to the person's daily rate — so shifts don't
    // clump into brutal single days even when totals are fair. Summed over
    // days (not one global max) so every day's worst case keeps exerting
    // pressure once some bad day is forced. peak is in integer per-mille of
    // the ratio (aux vars must be integral; see addContinuous warning).
    if (dailyPeakOn) {
      for (let ord = 0; ord < numDays; ord++) {
        interface Entry {
          rate: number;
          h?: { v: string; ub: number };
          constMinutes: number;
        }
        const entries: Entry[] = [];
        for (const p of data.persons) {
          if (!attrsByPerson.has(p.id)) continue;
          const h = hVar.get(p.id)?.get(ord);
          const constMinutes = constMin.get(p.id)?.[ord] ?? 0;
          if (!h && constMinutes === 0) continue;
          entries.push({ rate: rateMin(p), h, constMinutes });
        }
        if (entries.length === 0) continue;

        const ub = Math.max(
          ...entries.map((e) => Math.ceil((1000 * ((e.h?.ub ?? 0) + e.constMinutes)) / e.rate)),
        );
        // Continuous when ≥2 rows pin it; a single-entry day would make it a
        // column singleton in the objective — the presolve bug's exact shape —
        // so that case stays integer.
        const peak = entries.length >= 2 ? b.addContinuous(0, ub) : b.addInteger(0, ub);
        for (const e of entries) {
          // peak >= 1000 · (h + const) / rate
          const constPart = (1000 * e.constMinutes) / e.rate;
          if (e.h) {
            b.addConstraint([[e.h.v, 1000 / e.rate], [peak, -1]], "<=", -constPart, "daily-peak");
          } else {
            b.addConstraint([[peak, -1]], "<=", -constPart, "daily-peak");
          }
        }
        penalties.push([peak, -dailyPeak.weight / 1000]);
      }
    }
  }

  // Shift preferences: a signed bonus/penalty applied directly to an assignment
  // when a person's preference matches the instance's type and date. Positive
  // weight rewards assigning them; negative discourages it. A blank type/date
  // matches anything. Multiple matching preferences sum.
  const prefSettings = data.solverSettings.shiftPreferences;
  if (prefSettings.enabled && prefSettings.weight !== 0 && data.shiftPreferences.length > 0) {
    const typeOf = new Map(data.shiftTemplates.map((t) => [t.id, t.type]));
    const prefsByPerson = new Map<string, typeof data.shiftPreferences>();
    for (const pref of data.shiftPreferences) {
      (prefsByPerson.get(pref.personId) ?? prefsByPerson.set(pref.personId, []).get(pref.personId)!).push(pref);
    }
    for (const inst of instances) {
      const type = typeOf.get(inst.templateId) ?? "";
      const date = fmtLocalDateTime(inst.start).slice(0, 10);
      for (const [personId, v] of xByInstance.get(inst.id)!) {
        const prefs = prefsByPerson.get(personId);
        if (!prefs) continue;
        let signed = 0;
        for (const pref of prefs) {
          if (pref.shiftType !== "" && pref.shiftType !== type) continue;
          if (pref.dateRangeStart && date < pref.dateRangeStart) continue;
          if (pref.dateRangeEnd && date > pref.dateRangeEnd) continue;
          signed += pref.weight;
        }
        if (signed !== 0) penalties.push([v, prefSettings.weight * signed]);
      }
    }
  }

  // Person preferences: a signed co-assignment bonus/penalty for pairs. A
  // co-assignment indicator z = x_a AND x_b is linearised with three constraints
  // (lower + two upper bounds). Positive pair weight rewards co-assignment;
  // negative penalises it.
  const personPrefSettings = data.solverSettings.personPreferences;
  if (personPrefSettings.enabled && personPrefSettings.weight !== 0 && data.personPreferences.length > 0) {
    for (const inst of instances) {
      const xMap = xByInstance.get(inst.id)!;
      for (const pair of data.personPreferences) {
        if (pair.weight === 0) continue;
        const va = xMap.get(pair.personAId);
        const vb = xMap.get(pair.personBId);
        if (!va || !vb) continue;
        const z = b.addBinary();
        b.addConstraint([[va, 1], [vb, 1], [z, -1]], "<=", 1, "person-pref"); // z >= va + vb - 1
        b.addConstraint([[z, 1], [va, -1]], "<=", 0, "person-pref");           // z <= va
        b.addConstraint([[z, 1], [vb, -1]], "<=", 0, "person-pref");           // z <= vb
        penalties.push([z, personPrefSettings.weight * pair.weight]);
      }
    }
  }

  b.setObjective("max", [...coverage, ...penalties]);
  return { lp: b.toLP(), stats: b.stats(), data, instances, xVars, slotVar };
}

/** Interpret a HiGHS solution against the model context. */
export function interpretSolution(solution: HighsLikeSolution, ctx: ModelContext): GenerateResult {
  const templatesById = new Map(ctx.data.shiftTemplates.map((t) => [t.id, t]));

  // An instance is active if it has no slot (strict) or its slot was chosen.
  const isActive = (inst: ShiftInstance) => {
    const slot = ctx.slotVar.get(inst.id);
    return slot === undefined || LpBuilder.valueOf(solution, slot) === 1;
  };

  const activeInstances = ctx.instances.filter(isActive);
  const activeIds = new Set(activeInstances.map((i) => i.id));

  const shifts: GeneratedShift[] = activeInstances.map((inst) => {
    const t = templatesById.get(inst.templateId);
    return {
      instanceId: inst.id,
      templateId: inst.templateId,
      name: t?.name ?? "Shift",
      type: t?.type ?? "",
      start: fmtLocalDateTime(inst.start),
      durationMinutes: t?.durationMinutes ?? Math.round((inst.end.getTime() - inst.start.getTime()) / 60_000),
    };
  });

  const assignments: GeneratedAssignment[] = [];
  for (const [v, ref] of ctx.xVars) {
    if (!activeIds.has(ref.instanceId)) continue;
    if (LpBuilder.valueOf(solution, v) === 1) {
      assignments.push({ instanceId: ref.instanceId, personId: ref.personId });
    }
  }

  return {
    status: solution.Status,
    shifts,
    assignments,
    instancesConsidered: ctx.instances.length,
  };
}
