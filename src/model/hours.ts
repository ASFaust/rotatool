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
