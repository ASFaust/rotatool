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

/** Build the LP that fills empty slots across the given concrete shifts. */
export function buildAssignmentModel(data: AppData, shifts: Shift[]): ModelContext {
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
