/**
 * formulation.ts — turn the concrete shifts in a range into an assignment LP,
 * and read the solver's answer back into seat assignments.
 *
 * Pure (no Web Worker), so it is unit-testable in Node. The worker-driven
 * orchestration lives in generate.ts.
 *
 * The model only *fills empty slots*. A slot already holding a personId is fixed
 * — that person is marked busy for the shift's span and never gets a variable
 * for a conflicting seat. Decision variables:
 *  - x[seat, person] binary — person fills that empty seat. At most one person
 *    per seat (Σ x ≤ 1), so an unfillable seat just stays open.
 *
 * Hard constraints: attribute eligibility (a person must hold *all* of a
 * requirement's attributes) and availability gate which (seat, person) pairs
 * even get a variable; overlap mutually excludes a person's colliding seats —
 * which also stops one person taking two seats of the same shift. Required rest
 * between shifts is handled softly by the `breaks` term, not here.
 *
 * Objective (maximize): coverage rewards each filled seat, scaled by the shift's
 * `importance`; `required` seats carry a dominant reward so they fill first but
 * an understaffed roster degrades gracefully instead of going infeasible. The
 * `breaks` term subtracts a soft penalty when a person's seat starts inside
 * another of their seats' declared rest period.
 */

import { LpBuilder } from "./builder";
import type { HighsLikeSolution, LpStats } from "./builder";
import { isPersonAvailable } from "../model/ledger";
import { computeDerivedHours, weeklyHours, personStartDate, availableWeeks } from "../model/hours";
import type { AppData, Shift } from "../model/types";

/** A chosen (or candidate) placement of a person into one empty slot. */
export interface SeatAssignment {
  shiftId: string;
  reqIndex: number;
  slotIndex: number;
  personId: string;
}

export interface AssignResult {
  status: string;
  assignments: SeatAssignment[];
  seatsConsidered: number;
}

export interface ModelContext {
  lp: string;
  stats: LpStats;
  seatsConsidered: number;
  /** x var name -> the seat + person it represents. */
  xVars: Map<string, SeatAssignment>;
}

/** Two spans collide if they overlap in time. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

interface Seat {
  shiftId: string;
  reqIndex: number;
  slotIndex: number;
  start: number;
  end: number;
  breakMs: number;
  importance: number;
  required: boolean;
  attributeIds: string[];
}

interface Busy {
  start: number;
  end: number;
  breakMs: number;
}

/** A person's candidate seat: the var plus the span/break it occupies. */
interface SeatVar {
  v: string;
  start: number;
  end: number;
  breakMs: number;
  shiftId: string;
}

/**
 * Build the LP that fills empty slots across the given concrete shifts.
 * `rangeStart`/`rangeEnd` bound the solve window; the fairness term needs them to
 * pro-rate each person's load over the time they've been present (tenure).
 */
export function buildAssignmentModel(
  data: AppData,
  shifts: Shift[],
  rangeStart: Date,
  rangeEnd: Date,
): ModelContext {
  const b = new LpBuilder();

  // Activated person -> their attribute ids (for eligibility matching).
  const attrsByPerson = new Map<string, Set<string>>();
  for (const p of data.persons) if (p.activated) attrsByPerson.set(p.id, new Set());
  for (const pa of data.personAttributes) attrsByPerson.get(pa.personId)?.add(pa.attributeId);

  // Split slots into empty seats (to fill) and fixed assignments (busy time).
  const seats: Seat[] = [];
  const busyByPerson = new Map<string, Busy[]>();
  const addBusy = (pid: string, iv: Busy) =>
    (busyByPerson.get(pid) ?? busyByPerson.set(pid, []).get(pid)!).push(iv);

  for (const s of shifts) {
    const start = new Date(s.start).getTime();
    const end = start + s.durationMinutes * 60_000;
    const breakMs = s.breakMinutes * 60_000;
    s.requirements.forEach((r, reqIndex) => {
      r.slots.forEach((slot, slotIndex) => {
        if (slot === null) {
          seats.push({ shiftId: s.id, reqIndex, slotIndex, start, end, breakMs, importance: s.importance, required: r.required, attributeIds: r.attributeIds });
        } else {
          addBusy(slot, { start, end, breakMs });
        }
      });
    });
  }

  const coverageWeight = data.solverSettings.coverage.enabled ? data.solverSettings.coverage.weight : 0;
  // Per filled required seat. Dominant over ordinary coverage so required seats
  // fill first, but soft so an unfillable one just degrades the roster.
  const requiredWeight = 1000 * Math.max(1, coverageWeight);

  const xVars = new Map<string, SeatAssignment>();
  const coverage: [string, number][] = [];
  const penalties: [string, number][] = [];
  const seatVarsByPerson = new Map<string, SeatVar[]>();

  for (const seat of seats) {
    const seatVars: [string, number][] = [];
    for (const [personId, attrs] of attrsByPerson) {
      if (!seat.attributeIds.every((a) => attrs.has(a))) continue;
      if (!isPersonAvailable(data, personId, new Date(seat.start))) continue;
      const busy = busyByPerson.get(personId);
      if (busy?.some((iv) => overlaps(seat.start, seat.end, iv.start, iv.end))) continue;

      const x = b.addBinary();
      xVars.set(x, { shiftId: seat.shiftId, reqIndex: seat.reqIndex, slotIndex: seat.slotIndex, personId });
      seatVars.push([x, 1]);
      const w = seat.required ? requiredWeight : coverageWeight * Math.max(0, seat.importance);
      if (w > 0) coverage.push([x, w]);
      (seatVarsByPerson.get(personId) ?? seatVarsByPerson.set(personId, []).get(personId)!).push({
        v: x,
        start: seat.start,
        end: seat.end,
        breakMs: seat.breakMs,
        shiftId: seat.shiftId,
      });
    }
    if (seatVars.length > 0) b.addConstraint(seatVars, "<=", 1, "seat");
  }

  // Overlap: per person, one Σx ≤ 1 per maximal clique of overlapping seats. A
  // left-to-right sweep emits at most one clique per seat (and clique
  // constraints dominate the pairwise ones). This forbids any time overlap,
  // including two seats of the same shift.
  for (const [, segs] of seatVarsByPerson) {
    const ivs = segs
      .map((s) => ({ v: s.v, s: s.start, e: s.end }))
      .sort((a, c) => a.s - c.s || a.e - c.e);
    const emit = (clique: typeof ivs) => {
      if (clique.length >= 2) b.addConstraint(clique.map((iv): [string, number] => [iv.v, 1]), "<=", 1, "overlap");
    };
    let active: typeof ivs = [];
    let grown = false;
    for (const iv of ivs) {
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

  // Breaks: a shift's breakMinutes declares rest after it. Another of the same
  // person's seats starting inside that rest costs the violated minutes — soft,
  // so the solver pays a price instead of going infeasible. Seats hard-excluded
  // already (overlap / same shift) are skipped. One aux var per break carries
  // the worst violating cut, keeping the var count at one per break.
  const breaks = data.solverSettings.breaks;
  if (breaks.enabled && breaks.weight > 0) {
    const perMinute = breaks.weight / 60; // weight is per violated hour
    for (const [personId, segsRaw] of seatVarsByPerson) {
      const cands = [...segsRaw].sort((a, c) => a.start - c.start || a.end - c.end);
      for (const a of cands) {
        if (a.breakMs <= 0) continue;
        const restEnd = a.end + a.breakMs;
        const followers: { v: string; min: number }[] = [];
        for (const c of cands) {
          if (c.start >= restEnd) break; // sorted by start
          if (c === a || c.shiftId === a.shiftId) continue;
          if (c.start < a.end) continue; // overlap ⇒ hard-excluded
          followers.push({ v: c.v, min: (restEnd - c.start) / 60_000 });
        }
        if (followers.length === 0) continue;
        if (followers.length === 1) {
          // A single follower's continuous aux would be a presolve-unsafe column
          // singleton; use the pair-indicator binary instead (see addContinuous).
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

      // Fixed busy intervals (hand-assigned elsewhere): a pure break violation.
      for (const iv of busyByPerson.get(personId) ?? []) {
        const ivBreakEnd = iv.end + iv.breakMs;
        for (const c of cands) {
          let violMin = 0;
          if (c.start >= iv.end && c.start < ivBreakEnd) violMin += (ivBreakEnd - c.start) / 60_000;
          if (iv.start >= c.end && iv.start < c.end + c.breakMs) violMin += (c.end + c.breakMs - iv.start) / 60_000;
          if (violMin > 0) penalties.push([c.v, -perMinute * violMin]);
        }
      }
    }
  }

  // Peak window: flatten the single busiest stretch anyone works. One global
  // aux var `peak` is pinned ≥ the assigned minutes in *every* rolling
  // windowHours-long window faced by any person, and we penalize it — a min-max
  // that shrinks the worst window across the whole roster.
  //
  // A window's load only changes at a person's shift starts, and the densest
  // window can always be slid until its left edge sits on the earliest shift it
  // holds (sliding loses no shift). So testing windows anchored at each person's
  // own shift starts (candidate + hand-assigned) hits the exact continuous
  // maximum — no time grid needed. A shift counts in full if its start lies in
  // the window. `peak` is integer minutes: a trivial roster could leave it a
  // column singleton, and one integer aux var is cheap (see addContinuous).
  const peakCfg = data.solverSettings.peakWindow;
  if (peakCfg.enabled && peakCfg.weight > 0) {
    const perMinute = peakCfg.weight / 60; // weight is per hour of peak window
    const windowMs = peakCfg.windowHours * 3_600_000;

    interface DatedMin { start: number; min: number; v?: string }
    const loadByPerson = new Map<string, DatedMin[]>();
    const addLoad = (pid: string, x: DatedMin) =>
      (loadByPerson.get(pid) ?? loadByPerson.set(pid, []).get(pid)!).push(x);
    for (const [pid, segs] of seatVarsByPerson)
      for (const s of segs) addLoad(pid, { start: s.start, min: (s.end - s.start) / 60_000, v: s.v });
    for (const [pid, ivs] of busyByPerson)
      for (const iv of ivs) addLoad(pid, { start: iv.start, min: (iv.end - iv.start) / 60_000 });

    // A window can't hold more than all of a person's work; the largest such
    // total bounds the peak. (Skip building the var if nobody works at all.)
    let maxPossible = 0;
    for (const [, items] of loadByPerson)
      maxPossible = Math.max(maxPossible, items.reduce((s, i) => s + i.min, 0));

    if (maxPossible > 0) {
      const peak = b.addInteger(0, Math.ceil(maxPossible));
      for (const [, items] of loadByPerson) {
        const anchors = [...new Set(items.map((i) => i.start))].sort((a, c) => a - c);
        for (const a of anchors) {
          const inWindow = items.filter((i) => i.start >= a && i.start < a + windowMs);
          const terms: [string, number][] = [];
          let fixedSum = 0;
          for (const i of inWindow) {
            if (i.v) terms.push([i.v, i.min]);
            else fixedSum += i.min; // hand-assigned: constant load
          }
          if (terms.length === 0 && fixedSum === 0) continue;
          // Σ(min·x) + fixedSum ≤ peak  ⇔  Σ(min·x) − peak ≤ −fixedSum.
          b.addConstraint([...terms, [peak, -1]], "<=", -fixedSum, "peakwin");
        }
      }
      penalties.push([peak, -perMinute]);
    }
  }

  // Fairness: even out each person's *contribution rate over their tenure*. The
  // fair quantity is hours done per unit of time present, scaled by a relative
  // participation weight — so someone who has been around twice as long is
  // expected to have done about twice the work, and a half-weight part-timer
  // about half. Each person's ratio is:
  //
  //   ratio_p = (e_p + Σ durHours_s · x[s,p]) / (weight_p · present_p)
  //
  // where e_p = hours already worked (seeded `personHours` + hours derived from
  // filled ledger slots; newly-solved seats are still null there, so assigned-now
  // isn't double-counted), present_p = the weeks the person was effectively
  // available from their start through the window end (availability-aware, so
  // leave doesn't accrue expected time) divided by a reference tenure so the
  // term's scale (and the meaning of `fairness.weight`) stays stable, and
  // weight_p = their workload target read as a *relative* weight. This is
  // scale-invariant in weight: only the ratios between people matter, never the
  // absolute hours entered. People who left their target blank take a full share
  // (the largest entered target, so blank = full-timer); if nobody set one,
  // everyone is equal-weighted.
  //
  // (Businesses that want absolute contracted-hours targets instead of this
  // relative/tenure rule would add a new fairness mode here — same field, a
  // different objective — but that's intentionally not built yet.)
  //
  // Only people with a positive denominator carry a ratio (a person with no
  // available time in the span can't be assigned anyway). The term is built only
  // with ≥2 such people (fairness is meaningless below that, and it keeps every
  // aux var in ≥2 constraints — clear of the column-singleton presolve trap, see
  // builder.ts).
  const fairness = data.solverSettings.fairness;
  if (fairness.enabled && fairness.weight > 0) {
    // Already-worked hours per person (seed + derived from filled slots), kept
    // both as a grand total and split per shift type for `perShiftType` mode.
    const existingTotal = new Map<string, number>();
    const existingByType = new Map<string, Map<string, number>>(); // typeId -> personId -> hours
    const bump = (map: Map<string, number>, pid: string, h: number) => map.set(pid, (map.get(pid) ?? 0) + h);
    const typeBucket = (typeId: string) =>
      existingByType.get(typeId) ?? existingByType.set(typeId, new Map()).get(typeId)!;
    for (const ph of data.personHours) {
      bump(existingTotal, ph.personId, ph.hours);
      bump(typeBucket(ph.typeId), ph.personId, ph.hours);
    }
    for (const [pid, byType] of computeDerivedHours(data))
      for (const [typeId, h] of byType) {
        bump(existingTotal, pid, h);
        bump(typeBucket(typeId), pid, h);
      }

    // shiftId -> typeId, to group candidate seats by shift type.
    const typeByShift = new Map<string, string>();
    for (const s of shifts) typeByShift.set(s.id, s.typeId);

    // Per-person fairness denominator = relative weight · normalized tenure. The
    // weight is the entered weekly target read as a pure ratio; a blank target
    // takes a full share (the largest entered target, so blank = full-timer), and
    // if nobody set one everyone is weighted 1. Tenure is availability-aware weeks
    // from the person's start (or the window start, if they have no availability
    // on record) through the window end. Only people with some time present carry
    // a ratio.
    let maxRate = 0;
    for (const p of data.persons) {
      const r = weeklyHours(p);
      if (r && r > maxRate) maxRate = r;
    }
    const defaultWeight = maxRate > 0 ? maxRate : 1;

    // First pass: each candidate's relative weight and weeks present.
    const wp = new Map<string, { weight: number; present: number }>();
    for (const [personId] of seatVarsByPerson) {
      const p = data.persons.find((q) => q.id === personId);
      if (!p) continue;
      const r = weeklyHours(p);
      const weight = r && r > 0 ? r : defaultWeight;
      const start = personStartDate(data, personId) ?? rangeStart;
      const present = availableWeeks(data, personId, start, rangeEnd);
      if (weight > 0 && present > 0) wp.set(personId, { weight, present });
    }

    // Reference tenure = the median weeks-present. Dividing every person's tenure
    // by it keeps the term's magnitude — and so the meaning of `fairness.weight` —
    // independent of how long people have been around or how wide the date range
    // is. Without it, ratios shrink ~1/tenure and the weight silently loses bite.
    // It's one global divisor, so all ratios scale together: relative fairness is
    // unchanged, only the overall scale is fixed. For the median person tenure
    // normalizes to 1, so denom = weight and the term matches the pre-tenure scale.
    const presents = [...wp.values()].map((x) => x.present).sort((a, b) => a - b);
    const refWeeks = presents.length ? presents[Math.floor((presents.length - 1) / 2)] || 1 : 1;

    const denomByPerson = new Map<string, number>();
    for (const [personId, { weight, present }] of wp)
      denomByPerson.set(personId, weight * (present / refWeeks));

    // Balance one scope: every person with a denominator carries a ratio =
    // (already-worked + assigned-now hours in this scope) / denom_p. `seatFilter`
    // restricts the assigned-now seats counted; `existing` supplies the matching
    // already-worked hours. Run once globally, or once per shift type. People with
    // neither prior hours nor a candidate seat here are skipped.
    const addFairness = (existing: Map<string, number>, seatFilter: (sv: SeatVar) => boolean) => {
      interface RatioPerson { c: number; terms: [string, number][]; max: number }
      const people: RatioPerson[] = [];
      for (const [personId, segs] of seatVarsByPerson) {
        const denom = denomByPerson.get(personId);
        if (denom === undefined) continue;
        const c = (existing.get(personId) ?? 0) / denom;
        const terms: [string, number][] = [];
        let assignable = 0;
        for (const s of segs) {
          if (!seatFilter(s)) continue;
          const durHours = (s.end - s.start) / 3_600_000;
          terms.push([s.v, durHours / denom]);
          assignable += durHours / denom;
        }
        if (c === 0 && terms.length === 0) continue; // nothing in this scope
        people.push({ c, terms, max: c + assignable });
      }

      if (people.length < 2) return;
      const w = fairness.weight;
      const ratioUb = Math.max(...people.map((p) => p.max));
      if (fairness.mode === "deviation") {
        // L1: pull every ratio toward a free shared reference R; penalize Σ dev_p.
        //   dev_p ≥ ratio_p − R   and   dev_p ≥ R − ratio_p
        const R = b.addContinuous(0, ratioUb);
        for (const p of people) {
          const dev = b.addContinuous(0, ratioUb);
          b.addConstraint([...p.terms, [R, -1], [dev, -1]], "<=", -p.c, "fairness");
          b.addConstraint([...p.terms.map((t): [string, number] => [t[0], -t[1]]), [R, 1], [dev, -1]], "<=", p.c, "fairness");
          penalties.push([dev, -w]);
        }
      } else {
        // Min-max: penalize (max ratio − min ratio); the solver drives M to the
        // busiest ratio and m to the idlest, shrinking the gap between them.
        const M = b.addContinuous(0, ratioUb);
        const m = b.addContinuous(0, ratioUb);
        for (const p of people) {
          b.addConstraint([...p.terms, [M, -1]], "<=", -p.c, "fairness"); // M ≥ ratio_p
          b.addConstraint([...p.terms.map((t): [string, number] => [t[0], -t[1]]), [m, 1]], "<=", p.c, "fairness"); // m ≤ ratio_p
        }
        penalties.push([M, -w], [m, w]);
      }
    };

    if (fairness.perShiftType) {
      for (const st of data.shiftTypes)
        addFairness(existingByType.get(st.id) ?? new Map(), (sv) => typeByShift.get(sv.shiftId) === st.id);
    } else {
      addFairness(existingTotal, () => true);
    }
  }

  b.setObjective("max", [...coverage, ...penalties]);
  return { lp: b.toLP(), stats: b.stats(), seatsConsidered: seats.length, xVars };
}

/** Interpret a HiGHS solution against the model context. */
export function interpretSolution(solution: HighsLikeSolution, ctx: ModelContext): AssignResult {
  const assignments: SeatAssignment[] = [];
  for (const [v, ref] of ctx.xVars) {
    if (LpBuilder.valueOf(solution, v) === 1) assignments.push(ref);
  }
  return { status: solution.Status, assignments, seatsConsidered: ctx.seatsConsidered };
}
