/**
 * expand.ts — enumerate a repeating template's concrete occurrence *times* over a
 * date range. Pure date arithmetic; no weekday concept, no people.
 *
 * Each template recurs by `frequency` from its `activationDateTime` anchor:
 *
 *     occurrence k = anchor + k·frequency,   k = 0, 1, 2, …
 *
 * Every occurrence is pinned to a fixed day AND time (the only placement we
 * support for now — flexible times return later as nullable start fields). We
 * emit only occurrences whose start lies inside [rangeStart, rangeEnd).
 */

import type { ShiftTemplate } from "./types";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Safety cap so a tiny frequency over a huge range can't run away. */
const MAX_OCCURRENCES = 50_000;

/** Parse our local, timezone-free ISO datetime ("YYYY-MM-DDTHH:mm:ss") to a Date. */
function parseLocal(iso: string): Date {
  return new Date(iso);
}

function durationMs(value: number, unit: "days" | "hours"): number {
  return value * (unit === "days" ? MS_PER_DAY : MS_PER_HOUR);
}

/** Add whole days to a Date, preserving local time-of-day across DST. */
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/** Occurrence start times of a template whose start lies in [rangeStart, rangeEnd). */
export function occurrences(template: ShiftTemplate, rangeStart: Date, rangeEnd: Date): Date[] {
  const out: Date[] = [];
  if (!template.activated) return out;
  if (rangeEnd <= rangeStart) return out;

  const anchor = parseLocal(template.activationDateTime);
  const nominalWidth = durationMs(template.frequency.value, template.frequency.unit);
  if (!Number.isFinite(nominalWidth) || nominalWidth <= 0) return out;

  const anchorMs = anchor.getTime();
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();

  // Day-unit steps move by *calendar* days so wall-clock time survives DST.
  const byCalendar = template.frequency.unit === "days";
  const freqValue = template.frequency.value;
  const occAt = (k: number): Date =>
    byCalendar ? addDays(anchor, k * freqValue) : new Date(anchorMs + k * nominalWidth);

  // Back off a couple of windows around DST drift; the loop skips pre-range hits.
  let k = Math.max(0, Math.floor((startMs - anchorMs) / nominalWidth) - 2);
  for (; out.length < MAX_OCCURRENCES; k++) {
    const t = occAt(k);
    const ms = t.getTime();
    if (ms >= endMs) break;
    if (ms < startMs) continue;
    out.push(t);
  }
  return out;
}
