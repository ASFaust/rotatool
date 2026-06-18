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
import { isPersonAvailable } from "../model/rota";
import { computeUtilization } from "../model/hours";
import type { PersonUtilization } from "../model/hours";
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
 * Build the LP that fills empty slots over the window [rangeStart, rangeEnd).
 * Pass the *full* shift list as `allShifts`: the model creates seats only for
 * shifts that *start* in the window, but a shift starting outside it can still
 * constrain in-window seats (a still-running shift, a break reaching in, the peak
 * rolling window), so its *filled* slots are pulled in as fixed busy time. That
 * "halo" is bounded by time (the largest shift footprint and, if enabled, the
 * peak window), so it doesn't grow as the rota fills up over a season.
 *
 * `rangeStart`/`rangeEnd` also let the fairness term pro-rate each person's load
 * over the time they've been present (tenure).
 */
export function buildAssignmentModel(
  data: AppData,
  allShifts: Shift[],
  rangeStart: Date,
  rangeEnd: Date,
): ModelContext {
  const b = new LpBuilder();

  // Activated person -> their attribute ids (for eligibility matching).
  const attrsByPerson = new Map<string, Set<string>>();
  for (const p of data.persons) if (p.activated) attrsByPerson.set(p.id, new Set());
  for (const pa of data.personAttributes) attrsByPerson.get(pa.personId)?.add(pa.attributeId);

  const winStart = rangeStart.getTime();
  const winEnd = rangeEnd.getTime();

  // Halo margin: how far outside the window a *filled* shift can still reach an
  // in-window seat. Overlap and breaks reach at most one shift footprint
  // (duration + break) either side; the peak term reaches its window width. Use
  // the max so the halo is provably complete, yet bounded by time rather than by
  // total rota size.
  const peakCfg = data.solverSettings.peakWindow;
  const peakWindowMs = peakCfg.enabled && peakCfg.weight > 0 ? peakCfg.windowHours * 3_600_000 : 0;
  let maxFootprintMs = 0;
  for (const s of allShifts)
    maxFootprintMs = Math.max(maxFootprintMs, (s.durationMinutes + s.breakMinutes) * 60_000);
  const haloMs = Math.max(maxFootprintMs, peakWindowMs);

  // Split slots into empty seats (to fill) and fixed assignments (busy time).
  // Seats come only from shifts starting in the window; halo shifts (starting
  // outside but reaching in) contribute their filled slots as busy time only.
  const seats: Seat[] = [];
  const busyByPerson = new Map<string, Busy[]>();
  const addBusy = (pid: string, iv: Busy) =>
    (busyByPerson.get(pid) ?? busyByPerson.set(pid, []).get(pid)!).push(iv);

  for (const s of allShifts) {
    const start = new Date(s.start).getTime();
    const end = start + s.durationMinutes * 60_000;
    const breakMs = s.breakMinutes * 60_000;
    if (start >= winStart && start < winEnd) {
      s.requirements.forEach((r, reqIndex) => {
        r.slots.forEach((slot, slotIndex) => {
          if (slot === null) {
            seats.push({ shiftId: s.id, reqIndex, slotIndex, start, end, breakMs, importance: s.importance, required: r.required, attributeIds: r.attributeIds });
          } else {
            addBusy(slot, { start, end, breakMs });
          }
        });
      });
    } else if (start >= winStart - haloMs && start < winEnd + haloMs) {
      // Halo shift: only its filled slots matter, and only as busy time.
      for (const r of s.requirements)
        for (const slot of r.slots) if (slot !== null) addBusy(slot, { start, end, breakMs });
    }
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
  if (peakWindowMs > 0) {
    const perMinute = peakCfg.weight / 60; // weight is per hour of peak window
    const windowMs = peakWindowMs;

    interface DatedMin { start: number; min: number; v?: string }
    const loadByPerson = new Map<string, DatedMin[]>();
    const addLoad = (pid: string, x: DatedMin) =>
      (loadByPerson.get(pid) ?? loadByPerson.set(pid, []).get(pid)!).push(x);
    for (const [pid, segs] of seatVarsByPerson)
      for (const s of segs) addLoad(pid, { start: s.start, min: (s.end - s.start) / 60_000, v: s.v });
    // Busy intervals include the wider overlap/break halo; for peak only those
    // whose start can share a rolling window with an in-window seat matter
    // (within one window width of the range), so filter to avoid spurious anchors.
    for (const [pid, ivs] of busyByPerson)
      for (const iv of ivs)
        if (iv.start >= winStart - windowMs && iv.start < winEnd + windowMs)
          addLoad(pid, { start: iv.start, min: (iv.end - iv.start) / 60_000 });

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

  // Fairness: even out workload across people. Two regimes, picked by
  // `fairness.useHistory`:
  //
  //  - History-aware (on): steer each person toward a precomputed, per-person
  //    *target number of hours to newly assign* this window, accounting for what
  //    they've already worked relative to their availability-aware tenure. All the
  //    history reasoning lives in a plain pre-pass (computeUtilization); the LP
  //    sees only fixed target constants, so the aux vars are fully decoupled.
  //  - Plain (off): no targets, no tenure, no history — just balance the raw hours
  //    newly assigned this window across everyone who can be assigned.
  //
  // Either way `mode` selects the shape — "L1" pulls everyone toward a common
  // value / their own target, "min-max" squeezes the extremes — and `perShiftType`
  // runs it per type instead of over totals. Quantities are in *hours*, so
  // `fairness.weight` reads as "penalty per hour" of imbalance. Each scope's term
  // is built only with ≥2 people carrying decision hours (meaningless below that;
  // also keeps every aux var in ≥2 constraints, clear of the column-singleton
  // presolve trap — see builder.ts).
  const fairness = data.solverSettings.fairness;
  if (fairness.enabled && fairness.weight > 0) {
    const w = fairness.weight;
    const neg = (t: [string, number]): [string, number] => [t[0], -t[1]];

    // shiftId -> typeId, to group candidate seats (and the pool) by shift type.
    const typeByShift = new Map<string, string>();
    for (const s of allShifts) typeByShift.set(s.id, s.typeId);

    // The candidate seats in one scope for each person: their assigned-hours
    // expression (terms) and the most they could be given (assignable).
    interface ScopePerson { personId: string; terms: [string, number][]; assignable: number }
    const peopleIn = (seatIn: (sv: SeatVar) => boolean): ScopePerson[] => {
      const out: ScopePerson[] = [];
      for (const [personId, segs] of seatVarsByPerson) {
        const terms: [string, number][] = [];
        let assignable = 0;
        for (const s of segs) {
          if (!seatIn(s)) continue;
          const durHours = (s.end - s.start) / 3_600_000;
          terms.push([s.v, durHours]);
          assignable += durHours;
        }
        if (terms.length > 0) out.push({ personId, terms, assignable });
      }
      return out;
    };

    if (fairness.useHistory) {
      // ── History-aware: per-person hour targets from a utilization pre-pass. ──
      // Per eligible person p and scope:
      //   denom_p  = availableWeeks(start_p → rangeEnd) × weeklyHours_p   (expected hrs)
      //   worked_p = seed + rota-derived hours through rangeEnd (incl. already-
      //              filled in-window slots, so the target below isn't double-counted)
      //   T        = (Σ_elig worked + pool) / Σ_elig denom   ← post-distribution equal
      //              utilization: the center at which Σ targets = pool, so targets
      //              *distribute* the open seats instead of fighting coverage
      //   Δ_p      = T · denom_p − worked_p                  ← hours to reach target
      //   target_p = clamp(Δ_p, 0, min(maxCatchUp, assignable_p))
      // The lower-0 clamp is the add-only floor (over-utilized people → target 0 =
      // "assign nothing"); the upper bound caps per-window catch-up and never
      // exceeds reachable hours, so an unreachable target can't inject a constant
      // penalty. People without a start date or a positive weekly target are
      // ineligible (no denom) and excluded — the UI lists them in a warning.
      const util = computeUtilization(data, rangeEnd);
      const eligible = new Set([...util.values()].filter((u) => u.eligible).map((u) => u.personId));
      const sumDenom = [...util.values()].reduce((s, u) => s + (u.eligible ? u.denom : 0), 0);
      const cap = fairness.maxCatchUpHours;

      const poolByType = new Map<string, number>();
      let poolTotal = 0;
      for (const seat of seats) {
        const durHours = (seat.end - seat.start) / 3_600_000;
        const t = typeByShift.get(seat.shiftId);
        if (t) poolByType.set(t, (poolByType.get(t) ?? 0) + durHours);
        poolTotal += durHours;
      }

      const addFairness = (pool: number, workedOf: (u: PersonUtilization) => number, seatIn: (sv: SeatVar) => boolean) => {
        if (!(sumDenom > 0)) return;
        let sumWorked = 0;
        for (const u of util.values()) if (u.eligible) sumWorked += workedOf(u);
        const T = (sumWorked + pool) / sumDenom;

        const people = peopleIn(seatIn)
          .filter((p) => eligible.has(p.personId))
          .map((p) => {
            const u = util.get(p.personId)!;
            const target = Math.max(0, Math.min(T * u.denom - workedOf(u), cap, p.assignable));
            return { ...p, target };
          });
        if (people.length < 2) return;

        if (fairness.mode === "L1") {
          // Independent fixed targets: penalize Σ_p |assigned_p − target_p|.
          for (const p of people) {
            const dev = b.addContinuous(0, p.assignable);
            b.addConstraint([...p.terms, [dev, -1]], "<=", p.target, "fairness"); // dev ≥ assigned − target
            b.addConstraint([...p.terms.map(neg), [dev, -1]], "<=", -p.target, "fairness"); // dev ≥ target − assigned
            penalties.push([dev, -w]);
          }
        } else {
          // Min-max: shrink the single worst |assigned_p − target_p|.
          const M = b.addContinuous(0, Math.max(...people.map((p) => p.assignable)));
          for (const p of people) {
            b.addConstraint([...p.terms, [M, -1]], "<=", p.target, "fairness");
            b.addConstraint([...p.terms.map(neg), [M, -1]], "<=", -p.target, "fairness");
          }
          penalties.push([M, -w]);
        }
      };

      if (fairness.perShiftType) {
        for (const st of data.shiftTypes)
          addFairness(poolByType.get(st.id) ?? 0, (u) => u.workedByType.get(st.id) ?? 0, (sv) => typeByShift.get(sv.shiftId) === st.id);
      } else {
        addFairness(poolTotal, (u) => u.workedTotal, () => true);
      }
    } else {
      // ── Plain: balance the raw hours assigned this window, no history. ──
      // L1 pulls everyone toward a free shared reference R (penalize Σ|assigned−R|);
      // min-max squeezes (max assigned − min assigned). Everyone with a candidate
      // seat is included — no eligibility/tenure needed.
      const balance = (seatIn: (sv: SeatVar) => boolean) => {
        const people = peopleIn(seatIn);
        if (people.length < 2) return;
        const ub = Math.max(...people.map((p) => p.assignable));

        if (fairness.mode === "L1") {
          const R = b.addContinuous(0, ub);
          for (const p of people) {
            const dev = b.addContinuous(0, ub);
            b.addConstraint([...p.terms, [R, -1], [dev, -1]], "<=", 0, "fairness"); // dev ≥ assigned − R
            b.addConstraint([...p.terms.map(neg), [R, 1], [dev, -1]], "<=", 0, "fairness"); // dev ≥ R − assigned
            penalties.push([dev, -w]);
          }
        } else {
          const M = b.addContinuous(0, ub);
          const m = b.addContinuous(0, ub);
          for (const p of people) {
            b.addConstraint([...p.terms, [M, -1]], "<=", 0, "fairness"); // M ≥ assigned
            b.addConstraint([...p.terms.map(neg), [m, 1]], "<=", 0, "fairness"); // m ≤ assigned
          }
          penalties.push([M, -w], [m, w]);
        }
      };

      if (fairness.perShiftType) {
        for (const st of data.shiftTypes) balance((sv) => typeByShift.get(sv.shiftId) === st.id);
      } else {
        balance(() => true);
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
