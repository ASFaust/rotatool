/**
 * hours.ts — derive how many hours each person has worked per shift type from
 * the tracked ledger (the concrete `shifts`), the counterpart to the manually
 * seeded `personHours`. The Person Hours tab shows both side by side and sums
 * them; the optimizer will later consume the totals for fairness/distribution.
 */

import type { AppData } from "./types";

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
