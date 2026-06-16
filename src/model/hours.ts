/**
 * hours.ts — derive how many hours each person has worked per shift type from
 * the tracked ledger (the concrete `shifts`), the counterpart to the manually
 * seeded `personHours`. The Person Hours tab shows both side by side and sums
 * them; the optimizer will later consume the totals for fairness/distribution.
 */

import type { AppData, PersonHours } from "./types";

/** A filled slot contributes its shift's whole duration; null slots are ignored. */
export function computeDerivedHours(data: AppData): Map<string, Map<string, number>> {
  // personId -> (typeId -> summed hours)
  const out = new Map<string, Map<string, number>>();
  for (const s of data.shifts) {
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
 * Pro-rata seed hours for the Person Hours autofill tool. For each active
 * person, hours they "should" have worked from their start through `endDate` at
 * their weekly target, split across shift types by `weights` (relative ratios).
 *
 *   weeks_p  = max(0, (endDate − start_p) / 1 week)
 *   target_p = weeklyHours_p × weeks_p
 *   seed_p,t = target_p × weight_t / Σ weight
 *
 * People lacking an availability start or a workload target are skipped. Types
 * whose weight is ≤ 0 get nothing. Returns the full replacement `personHours`
 * (only non-zero rows, matching the sparse storage convention).
 *
 * NOTE: this reads `weeklyHours` as an *absolute* hours commitment. The solver's
 * fairness term, by contrast, treats it as a *relative* weight (only ratios
 * between people matter). So a seed produced here is on a real-hours scale and is
 * only approximately commensurate with hours derived from tracked shifts when the
 * entered targets aren't literal hours — acceptable for the mid-season seed.
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

  for (const p of data.persons) {
    if (!p.activated) continue;
    const start = personStartDate(data, p.id);
    const perWeek = weeklyHours(p);
    if (!start || perWeek === null) continue;
    const weeks = Math.max(0, (end - start.getTime()) / MS_PER_WEEK);
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
