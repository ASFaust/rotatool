/**
 * expand.ts — materialize shift *templates* into concrete dated *instances*
 * over a user-chosen date range. Pure date arithmetic; no weekday concept.
 *
 * Recurrence model (see plan.md): each template has an `anchor`
 * (activationDateTime = the first occurrence) and a `frequency` duration that
 * defines successive windows
 *
 *     window k = [anchor + k·freq, anchor + (k+1)·freq),  k = 0, 1, 2, …
 *
 * `placement` decides what each window emits:
 *   - strict      one occurrence pinned to `anchor + k·freq` (fixed day & time).
 *   - strictTime  the anchor's time-of-day on *each day* of the window — the
 *                 solver later picks which day (candidates share a windowGroupId).
 *   - anyTime     candidates spaced by `anyTimeGranularity` (default 1/day at the
 *                 anchor time) across the window — solver picks day & time.
 *
 * We only emit candidates whose **start falls inside the requested range**, so a
 * window that merely overlaps the range boundary never yields out-of-range
 * occurrences. `end = start + durationMinutes`.
 */

import type { AppData, ShiftTemplate, ShiftInstance, InstanceRequirement } from "./types";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Safety cap so a tiny frequency over a huge range can't run away. */
const MAX_INSTANCES = 50_000;

/** Parse our local, timezone-free ISO datetime ("YYYY-MM-DDTHH:mm:ss") to a Date. */
function parseLocal(iso: string): Date {
  // Date-time forms without an offset are interpreted as local time by spec.
  return new Date(iso);
}

/** Width of one recurrence window, in milliseconds. */
function durationMs(value: number, unit: "days" | "hours"): number {
  return value * (unit === "days" ? MS_PER_DAY : MS_PER_HOUR);
}

/** Add whole days to a Date, preserving local time-of-day across DST. */
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/**
 * Expand a single template's occurrences whose start lies in [rangeStart, rangeEnd).
 * `requirements` are the template's requirement slots, resolved to instance form.
 */
export function expandTemplate(
  template: ShiftTemplate,
  requirements: InstanceRequirement[],
  rangeStart: Date,
  rangeEnd: Date,
  out: ShiftInstance[],
): void {
  if (!template.activated) return;
  if (rangeEnd <= rangeStart) return;

  const anchor = parseLocal(template.activationDateTime);
  const nominalWidth = durationMs(template.frequency.value, template.frequency.unit);
  if (!Number.isFinite(nominalWidth) || nominalWidth <= 0) return;

  const anchorMs = anchor.getTime();
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();

  // Day-unit windows step by *calendar* days so the wall-clock time-of-day is
  // preserved across daylight-saving boundaries ("every day 09:00" stays 09:00).
  // Hour-unit windows use exact millisecond arithmetic.
  const byCalendar = template.frequency.unit === "days";
  const freqValue = template.frequency.value;
  const windowStartAt = (k: number): Date =>
    byCalendar ? addDays(anchor, k * freqValue) : new Date(anchorMs + k * nominalWidth);

  const inRange = (ms: number) => ms >= startMs && ms < endMs;
  const push = (start: Date, suffix: string, windowGroupId?: string) => {
    if (out.length >= MAX_INSTANCES) return;
    out.push({
      id: `${template.id}|${suffix}`,
      templateId: template.id,
      start,
      end: new Date(start.getTime() + template.durationMinutes * 60_000),
      requirements,
      windowGroupId,
    });
  };

  // First window that might overlap the range. The nominal-width estimate can be
  // off by one around DST, so back off a couple of windows; the loop then skips
  // anything that doesn't actually overlap and stops once windows pass the range.
  let k = Math.max(0, Math.floor((startMs - anchorMs) / nominalWidth) - 2);
  for (; out.length < MAX_INSTANCES; k++) {
    const windowStart = windowStartAt(k);
    if (windowStart.getTime() >= endMs) break; // windows only move forward
    const windowEndMs = windowStartAt(k + 1).getTime();
    if (windowEndMs <= startMs) continue; // window entirely before the range

    if (template.placement === "strict") {
      if (inRange(windowStart.getTime())) push(windowStart, `w${k}`);
      continue;
    }

    const groupId = `${template.id}|w${k}`;

    if (template.placement === "strictTime") {
      // One candidate per calendar day in the window, at the window-start time.
      let day = windowStart;
      let i = 0;
      while (day.getTime() < windowEndMs) {
        if (inRange(day.getTime())) push(day, `w${k}d${i}`, groupId);
        day = addDays(day, 1);
        i++;
      }
      continue;
    }

    // anyTime: step by the granularity (default one candidate per day).
    const gran = template.anyTimeGranularity;
    const stepByCalendar = gran ? gran.unit === "days" : true;
    const stepValue = gran ? gran.value : 1;
    const stepMs = gran ? durationMs(gran.value, gran.unit) : MS_PER_DAY;
    if (stepMs <= 0) continue;
    let i = 0;
    let slot = windowStart;
    while (slot.getTime() < windowEndMs) {
      if (inRange(slot.getTime())) push(slot, `w${k}s${i}`, groupId);
      slot = stepByCalendar ? addDays(slot, stepValue) : new Date(slot.getTime() + stepMs);
      i++;
    }
  }
}

/** Expand all activated templates in the dataset over [rangeStart, rangeEnd). */
export function expandAll(data: AppData, rangeStart: Date, rangeEnd: Date): ShiftInstance[] {
  const out: ShiftInstance[] = [];
  for (const template of data.shiftTemplates) {
    const reqs: InstanceRequirement[] = data.shiftRequirements
      .filter((r) => r.shiftId === template.id)
      .map((r) => ({ attributeId: r.attributeId, count: r.count }));
    expandTemplate(template, reqs, rangeStart, rangeEnd, out);
  }
  return out;
}
