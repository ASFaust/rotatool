/**
 * ledger.ts — operations on the concrete, dated timeline of Shifts and the
 * people in their staffing slots.
 *
 * A Shift's requirement slots are the solver boundary: a `null` slot is a
 * decision for the solver, a `personId` slot is fixed by hand. There is no
 * status enum — "filled vs. to-be-filled" is just slot nullness.
 *
 * Responsibilities:
 *  - instance repeating templates into concrete Shifts over a range (reconcile:
 *    create missing, re-sync untouched instances to their template, freeze edited
 *    ones, drop untouched orphans)
 *  - create / edit / delete concrete shifts and their requirement slots
 *  - manual slot (un)assignment
 *  - availability checks + reconciliation notifications
 *
 * Effective availability = union(available) minus union(unavailable), at date
 * granularity. A person with no `available` interval is treated as always
 * available (so the tool is usable before stays are entered).
 */

import { getAppData, newId } from "./store";
import { DEFAULT_SHIFT_TYPE_ID } from "./schema";
import { mutate } from "./mutations";
import { occurrences } from "./expand";
import type { AppData, Shift, ShiftRequirement, ShiftTemplate } from "./types";

// --- Local datetime formatting (timezone-free, seconds precision) ----------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtLocalDateTime(d: Date): string {
  return `${fmtLocalDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// --- Availability ----------------------------------------------------------

/** Is the person effectively available at the given moment (day granularity)? */
export function isPersonAvailable(data: AppData, personId: string, when: Date): boolean {
  const day = fmtLocalDate(when);
  const intervals = data.availability.filter((a) => a.personId === personId);
  const covers = (kind: "available" | "unavailable") =>
    intervals.some((a) => a.kind === kind && a.start <= day && (a.end === undefined || day <= a.end));

  const hasAvailableInterval = intervals.some((a) => a.kind === "available");
  const available = hasAvailableInterval ? covers("available") : true;
  return available && !covers("unavailable");
}

// --- Template instancing ----------------------------------------------------

/** The requirement slots a fresh instance of this template should carry (all empty). */
function templateRequirements(t: ShiftTemplate): ShiftRequirement[] {
  return t.requirements.map((r) => ({
    attributeIds: [...r.attributeIds],
    required: r.required,
    slots: Array<string | null>(r.count).fill(null),
  }));
}

/** True if no slot on the shift is filled. */
function isUnassigned(s: Shift): boolean {
  return s.requirements.every((r) => r.slots.every((slot) => slot === null));
}

/**
 * True if `s` still matches what `t` would generate and has no hand-assignment —
 * i.e. it is safe to re-sync from the template. Any divergence or filled slot
 * means the user touched it, so we leave it frozen.
 */
function isUntouched(s: Shift, t: ShiftTemplate): boolean {
  if (!isUnassigned(s)) return false;
  if (s.name !== t.name || s.typeId !== t.typeId || s.importance !== t.importance) return false;
  if (s.durationMinutes !== t.durationMinutes || s.breakMinutes !== t.breakMinutes) return false;
  if (s.requirements.length !== t.requirements.length) return false;
  return s.requirements.every((a, i) => {
    const b = t.requirements[i];
    return (
      a.slots.length === b.count &&
      a.required === b.required &&
      a.attributeIds.length === b.attributeIds.length &&
      a.attributeIds.every((x, j) => x === b.attributeIds[j])
    );
  });
}

/** Signature of a requirement list's attribute sets — order-insensitive. */
function attrSig(reqs: { attributeIds: string[] }[]): string {
  return JSON.stringify(reqs.map((r) => [...r.attributeIds].sort()));
}

function templateAttrSig(t: ShiftTemplate): string {
  return JSON.stringify(t.requirements.map((r) => [...r.attributeIds].sort()));
}

export interface InstanceResult {
  created: number;
  resynced: number;
  removed: number;
}

/**
 * Instance every active template into the [rangeStart, rangeEnd) window and
 * reconcile against existing instances. Throws if a template's required
 * attributes changed while it still has hand-assigned instances (the user must
 * resolve those by hand for now).
 */
export function instanceTemplates(rangeStart: Date, rangeEnd: Date): InstanceResult {
  const data = getAppData();
  const startStr = fmtLocalDateTime(rangeStart);
  const endStr = fmtLocalDateTime(rangeEnd);
  const inRange = (s: string) => s >= startStr && s < endStr;

  // --- Guard pass (no mutation): refuse to reconcile a template whose required
  // attributes drifted away from an instance that already has people on it.
  for (const t of data.shiftTemplates) {
    const sig = templateAttrSig(t);
    for (const s of data.shifts) {
      if (s.sourceTemplateId !== t.id) continue;
      if (isUnassigned(s)) continue;
      if (attrSig(s.requirements) !== sig) {
        throw new Error(
          `Template "${t.name}" has assigned instances but its required attributes changed. ` +
            `Resolve those instances by hand before re-instancing.`,
        );
      }
    }
  }

  let created = 0;
  let resynced = 0;
  let removed = 0;

  mutate((d) => {
    for (const t of d.shiftTemplates) {
      if (!t.activated) continue;
      const starts = occurrences(t, rangeStart, rangeEnd).map(fmtLocalDateTime);
      const wanted = new Set(starts);
      const byStart = new Map<string, Shift>();
      for (const s of d.shifts) if (s.sourceTemplateId === t.id) byStart.set(s.start, s);

      for (const start of starts) {
        const existing = byStart.get(start);
        if (!existing) {
          d.shifts.push({
            id: newId(),
            name: t.name,
            typeId: t.typeId,
            importance: t.importance,
            start,
            durationMinutes: t.durationMinutes,
            breakMinutes: t.breakMinutes,
            requirements: templateRequirements(t),
            sourceTemplateId: t.id,
          });
          created++;
        } else if (isUntouched(existing, t)) {
          existing.name = t.name;
          existing.typeId = t.typeId;
          existing.importance = t.importance;
          existing.durationMinutes = t.durationMinutes;
          existing.breakMinutes = t.breakMinutes;
          existing.requirements = templateRequirements(t);
          resynced++;
        }
        // else: user-edited instance — leave frozen.
      }
    }

    // Drop untouched orphans whose occurrence vanished but fall in the range.
    const templateById = new Map(d.shiftTemplates.map((t) => [t.id, t]));
    d.shifts = d.shifts.filter((s) => {
      if (!s.sourceTemplateId) return true;
      const t = templateById.get(s.sourceTemplateId);
      if (!t) return true;
      const starts = new Set(occurrences(t, rangeStart, rangeEnd).map(fmtLocalDateTime));
      if (starts.has(s.start) || !inRange(s.start)) return true;
      if (isUntouched(s, t)) {
        removed++;
        return false;
      }
      return true;
    });
  });

  return { created, resynced, removed };
}

// --- Concrete shift CRUD ----------------------------------------------------

/** Create a one-off concrete shift (no template); returns its id. */
export function addShift(input: {
  name: string;
  typeId?: string;
  start: string;
  durationMinutes: number;
  importance?: number;
  breakMinutes?: number;
}): string {
  const id = newId();
  mutate((d) =>
    d.shifts.push({
      id,
      name: input.name,
      typeId: input.typeId ?? DEFAULT_SHIFT_TYPE_ID,
      importance: input.importance ?? 1,
      start: input.start,
      durationMinutes: input.durationMinutes,
      breakMinutes: input.breakMinutes ?? 0,
      requirements: [],
    }),
  );
  return id;
}

export function updateShift(id: string, patch: Partial<Shift>): void {
  mutate((d) => {
    const s = d.shifts.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
  });
}

export function removeShift(id: string): void {
  mutate((d) => {
    d.shifts = d.shifts.filter((s) => s.id !== id);
  });
}

// --- Requirements + slots ---------------------------------------------------

export function addRequirement(shiftId: string): void {
  mutate((d) => {
    const s = d.shifts.find((x) => x.id === shiftId);
    if (s) s.requirements.push({ attributeIds: [], required: false, slots: [null] });
  });
}

export function updateRequirement(
  shiftId: string,
  reqIndex: number,
  patch: Partial<Pick<ShiftRequirement, "attributeIds" | "required">>,
): void {
  mutate((d) => {
    const r = d.shifts.find((x) => x.id === shiftId)?.requirements[reqIndex];
    if (r) Object.assign(r, patch);
  });
}

export function removeRequirement(shiftId: string, reqIndex: number): void {
  mutate((d) => {
    const s = d.shifts.find((x) => x.id === shiftId);
    if (s) s.requirements.splice(reqIndex, 1);
  });
}

/** Grow or shrink a requirement's head-count. Shrinking drops trailing slots. */
export function setSlotCount(shiftId: string, reqIndex: number, count: number): void {
  mutate((d) => {
    const r = d.shifts.find((x) => x.id === shiftId)?.requirements[reqIndex];
    if (!r) return;
    const n = Math.max(1, Math.floor(count));
    if (n > r.slots.length) while (r.slots.length < n) r.slots.push(null);
    else r.slots.length = n;
  });
}

/** Set (personId) or clear (null) one slot. */
export function assignSlot(
  shiftId: string,
  reqIndex: number,
  slotIndex: number,
  personId: string | null,
): void {
  mutate((d) => {
    const r = d.shifts.find((x) => x.id === shiftId)?.requirements[reqIndex];
    if (r && slotIndex >= 0 && slotIndex < r.slots.length) r.slots[slotIndex] = personId;
  });
}

/** Empty every slot on shifts whose start is in [rangeStart, rangeEnd). Returns slots cleared. */
export function clearAssignmentsInRange(rangeStart: Date, rangeEnd: Date): number {
  const startStr = fmtLocalDateTime(rangeStart);
  const endStr = fmtLocalDateTime(rangeEnd);
  let cleared = 0;
  mutate((d) => {
    for (const s of d.shifts) {
      if (s.start < startStr || s.start >= endStr) continue;
      for (const r of s.requirements)
        for (let i = 0; i < r.slots.length; i++)
          if (r.slots[i] !== null) {
            r.slots[i] = null;
            cleared++;
          }
    }
  });
  return cleared;
}

// --- Reconciliation --------------------------------------------------------

export interface AvailabilityConflict {
  shiftId: string;
  personId: string;
  personName: string;
  shiftName: string;
  start: string;
}

/** Hand-assigned people who now fall outside their effective availability. */
export function reconcileAvailability(data: AppData): AvailabilityConflict[] {
  const personById = new Map(data.persons.map((p) => [p.id, p]));
  const conflicts: AvailabilityConflict[] = [];
  for (const s of data.shifts) {
    const when = new Date(s.start);
    for (const r of s.requirements) {
      for (const pid of r.slots) {
        if (pid && !isPersonAvailable(data, pid, when)) {
          conflicts.push({
            shiftId: s.id,
            personId: pid,
            personName: personById.get(pid)?.name ?? "?",
            shiftName: s.name,
            start: s.start,
          });
        }
      }
    }
  }
  return conflicts;
}
