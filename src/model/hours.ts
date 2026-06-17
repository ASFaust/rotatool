/**
 * hours.ts — derive how many hours each person has worked per shift type from
 * the tracked ledger (the concrete `shifts`), the counterpart to the manually
 * seeded `personHours`. The Person Hours tab shows both side by side and sums
 * them; the optimizer will later consume the totals for fairness/distribution.
 */

import type { AppData, PersonHours } from "./types";

/**
 * A filled slot contributes its shift's whole duration; null slots are ignored.
 * `before` (optional) excludes shifts starting at/after that instant — the solver
 * passes the window end so the fairness `e_p` only counts work whose span lines
 * up with the tenure denominator (which also runs through the window end).
 */
export function computeDerivedHours(data: AppData, before?: Date): Map<string, Map<string, number>> {
  const cutoff = before?.getTime();
  // personId -> (typeId -> summed hours)
  const out = new Map<string, Map<string, number>>();
  for (const s of data.shifts) {
    if (cutoff !== undefined && new Date(s.start).getTime() >= cutoff) continue;
    const hrs = s.durationMinutes / 60;
    for (const r of s.requirements) {
      for (const slot of r.slots) {
        if (!slot) continue;
        let byType = out.get(slot);
        if (!byType) out.set(slot, (byType = new Map()));
        byType.set(s.typeId, (byType.get(s.typeId) ?? 0) + hrs);
      }
    }
  }
  return out;
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * The date a person "started", i.e. the earliest `available` interval start on
 * record. Returns null when the person has no positive availability — we can't
 * pro-rate hours without a starting point.
 */
export function personStartDate(data: AppData, personId: string): Date | null {
  let earliest: number | null = null;
  for (const a of data.availability) {
    if (a.personId !== personId || a.kind !== "available") continue;
    const t = new Date(a.start).getTime();
    if (earliest === null || t < earliest) earliest = t;
  }
  return earliest === null ? null : new Date(earliest);
}

/** Normalize a person's workload target to an hours-per-week rate, or null. */
export function weeklyHours(person: AppData["persons"][number]): number | null {
  const h = person.hoursPerTimeframe;
  if (!h) return null;
  switch (h.unit) {
    case "day": return h.value * 7;
    case "week": return h.value;
    case "month": return (h.value * 12) / 52; // 52 weeks / 12 months
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Iv { s: number; e: number }

/** Merge overlapping/touching intervals into a disjoint, sorted set. */
function mergeIvs(ivs: Iv[]): Iv[] {
  const sorted = ivs.filter((i) => i.e > i.s).sort((a, b) => a.s - b.s);
  const out: Iv[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.s <= last.e) last.e = Math.max(last.e, iv.e);
    else out.push({ ...iv });
  }
  return out;
}

/** union(base) minus union(subs), as a disjoint interval set. */
function subtractIvs(base: Iv[], subs: Iv[]): Iv[] {
  let result = mergeIvs(base);
  for (const cut of mergeIvs(subs)) {
    const next: Iv[] = [];
    for (const iv of result) {
      if (cut.e <= iv.s || cut.s >= iv.e) { next.push(iv); continue; } // disjoint
      if (cut.s > iv.s) next.push({ s: iv.s, e: cut.s });
      if (cut.e < iv.e) next.push({ s: cut.e, e: iv.e });
    }
    result = next;
  }
  return result;
}

/**
 * Effective-availability duration, in weeks, that `personId` has within
 * [from, to) — i.e. union(available) minus union(unavailable), clamped to the
 * window. Matches `isPersonAvailable`'s day-granular, inclusive-end semantics
 * (a person with no `available` interval is always available). Used by the
 * solver's fairness term to pro-rate work over the time a person was actually
 * present, so leave periods don't accrue "expected" hours.
 */
export function availableWeeks(data: AppData, personId: string, from: Date, to: Date): number {
  const avail: Iv[] = [];
  const unavail: Iv[] = [];
  let hasAvail = false;
  for (const a of data.availability) {
    if (a.personId !== personId) continue;
    const s = new Date(a.start).getTime();
    // Inclusive end day: an interval ending on day D covers through end of D.
    const e = a.end ? new Date(a.end).getTime() + MS_PER_DAY : Infinity;
    if (a.kind === "available") { hasAvail = true; avail.push({ s, e }); }
    else unavail.push({ s, e });
  }
  const base: Iv[] = hasAvail ? avail : [{ s: -Infinity, e: Infinity }];
  const fromMs = from.getTime();
  const toMs = to.getTime();
  let total = 0;
  for (const iv of subtractIvs(base, unavail)) {
    const s = Math.max(iv.s, fromMs);
    const e = Math.min(iv.e, toMs);
    if (e > s) total += e - s;
  }
  return total / MS_PER_WEEK;
}

/**
 * Per-person utilization through `horizon` — the comparable, tenure-normalized
 * pace signal that drives the fairness target pre-pass and the Person Hours
 * diagnostic. For each person:
 *
 *   denom_p   = availableWeeks(start_p → horizon) × weeklyHours_p   (expected hours)
 *   worked_pt = seed (personHours) + ledger-derived hours, measured through horizon
 *   U_pt      = worked_pt / denom_p   (dimensionless, comparable across people)
 *
 * `denom_p` is one shared denominator across all shift types, so per-type `U_pt`
 * sum to the person's total `U_p` (total and per-type fairness fall out of the
 * same number). It is availability-aware (leave doesn't accrue expected hours).
 *
 * `eligible` is false for anyone missing a start date or a positive weekly target
 * (denom 0) — they are excluded from the fairness term and surfaced in a warning,
 * replacing the old "blank target = full share / no start = window start"
 * fallbacks. Worked hours are still reported for them (useful on the tab).
 */
export interface PersonUtilization {
  personId: string;
  eligible: boolean;
  /** Expected hours over the person's tenure through `horizon`; 0 when ineligible. */
  denom: number;
  /** typeId -> already-worked hours (seed + ledger-derived through horizon). */
  workedByType: Map<string, number>;
  workedTotal: number;
}

export function computeUtilization(data: AppData, horizon: Date): Map<string, PersonUtilization> {
  const derived = computeDerivedHours(data, horizon);
  const seedByPerson = new Map<string, Map<string, number>>();
  for (const ph of data.personHours) {
    let m = seedByPerson.get(ph.personId);
    if (!m) seedByPerson.set(ph.personId, (m = new Map()));
    m.set(ph.typeId, (m.get(ph.typeId) ?? 0) + ph.hours);
  }

  const out = new Map<string, PersonUtilization>();
  for (const p of data.persons) {
    const workedByType = new Map<string, number>();
    const bump = (typeId: string, h: number) => workedByType.set(typeId, (workedByType.get(typeId) ?? 0) + h);
    for (const [typeId, h] of seedByPerson.get(p.id) ?? []) bump(typeId, h);
    for (const [typeId, h] of derived.get(p.id) ?? []) bump(typeId, h);
    let workedTotal = 0;
    for (const h of workedByType.values()) workedTotal += h;

    const start = personStartDate(data, p.id);
    const perWeek = weeklyHours(p);
    let denom = 0;
    if (start && perWeek !== null && perWeek > 0) denom = availableWeeks(data, p.id, start, horizon) * perWeek;
    out.set(p.id, { personId: p.id, eligible: denom > 0, denom, workedByType, workedTotal });
  }
  return out;
}

/**
 * Pro-rata seed hours for the Person Hours autofill tool. For each active person,
 * the hours they "should" have worked from their start through `endDate` at their
 * weekly target, split across shift types by `weights`.
 *
 *   weeks_p  = availableWeeks(start_p → endDate, inclusive)
 *   target_p = weeklyHours_p × weeks_p
 *   seed_p,t = target_p × weight_t / Σ weight
 *
 * `weeks_p` is the **same availability-aware expected-hours** measure the fairness
 * pre-pass and the Person Hours pace use (`computeUtilization`'s `denom`), over an
 * inclusive end-of-day endpoint — so a freshly-autofilled roster (no tracked
 * ledger hours yet) reads an even ~100% pace for everyone, and leave doesn't
 * inflate the seed. People lacking an availability start or a positive weekly
 * target are skipped; types with weight ≤ 0 get nothing. Returns the full
 * replacement `personHours` (only non-zero rows, the sparse convention).
 */
export function computePrefillSeed(
  data: AppData,
  endDateIso: string,
  weights: Map<string, number>,
): PersonHours[] {
  const end = new Date(endDateIso).getTime();
  let weightSum = 0;
  for (const st of data.shiftTypes) weightSum += Math.max(0, weights.get(st.id) ?? 0);

  const rows: PersonHours[] = [];
  if (!(weightSum > 0) || Number.isNaN(end)) return rows;
  // Treat `endDate` as inclusive (through the end of that day), matching the
  // day-granular semantics of `availableWeeks` and the pace horizon on the tab.
  const endInclusive = new Date(end + MS_PER_DAY);

  for (const p of data.persons) {
    if (!p.activated) continue;
    const start = personStartDate(data, p.id);
    const perWeek = weeklyHours(p);
    if (!start || perWeek === null) continue;
    const weeks = availableWeeks(data, p.id, start, endInclusive);
    const target = perWeek * weeks;
    if (!(target > 0)) continue;
    for (const st of data.shiftTypes) {
      const w = Math.max(0, weights.get(st.id) ?? 0);
      if (w <= 0) continue;
      const hours = (target * w) / weightSum;
      if (hours > 0) rows.push({ personId: p.id, typeId: st.id, hours });
    }
  }
  return rows;
}
