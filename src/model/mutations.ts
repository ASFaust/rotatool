/**
 * mutations.ts — small helpers for editing the live dataset.
 *
 * `mutate(fn)` runs a mutator against the store and notifies subscribers. The
 * named helpers cover the operations that need care — chiefly deletes, which
 * must cascade so no reference is left dangling. Concrete-shift operations
 * (instancing, slot assignment) live in ledger.ts.
 */

import { appData, newId } from "./store";
import { recordCommit } from "./history";
import { DEFAULT_SHIFT_TYPE_ID, SHIFT_TYPE_COLORS } from "./schema";
import type { AppData, Person, Attribute, ShiftType, ShiftTemplate, ShiftRequirement, TemplateRequirement } from "./types";

/**
 * Apply an in-place mutation to the dataset and trigger reactivity.
 *
 * We mutate a deep clone and return that fresh structure rather than the same
 * (or shallowly-copied) reference. Svelte 5's store→rune bridge (`$appData` in
 * components) compares with strict `!==`, and so does every intermediate
 * `$derived` — e.g. `selected = $appData.shifts.find(...)`. If a mutator edits a
 * nested slot/requirement in place, those references don't change, so the
 * detail panel and timeline would stay stale until a reload even though the
 * persisted data was updated. Deep-cloning gives every touched level a new
 * reference, which is the immutable-update model Svelte's reactivity expects.
 * The dataset is small (an in-browser rota tool) so the clone cost is trivial.
 */
export function mutate(fn: (data: AppData) => void): void {
  appData.update((data) => {
    const next = structuredClone(data);
    fn(next);
    recordCommit(data, next);
    return next;
  });
}

// --- People ----------------------------------------------------------------

export function addPerson(name: string): string {
  const id = newId();
  mutate((d) => {
    d.persons.push({ id, name, activated: true });
  });
  return id;
}

export function updatePerson(id: string, patch: Partial<Person>): void {
  mutate((d) => {
    const p = d.persons.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  });
}

/** Delete a person and every row that references them; clear them from any slots. */
export function removePerson(id: string): void {
  mutate((d) => {
    d.persons = d.persons.filter((p) => p.id !== id);
    d.personAttributes = d.personAttributes.filter((pa) => pa.personId !== id);
    d.availability = d.availability.filter((a) => a.personId !== id);
    d.personHours = d.personHours.filter((h) => h.personId !== id);
    for (const s of d.shifts)
      for (const r of s.requirements)
        r.slots = r.slots.map((slot) => (slot === id ? null : slot));
  });
}

// --- Attributes ------------------------------------------------------------

export function addAttribute(name: string): string {
  const id = newId();
  mutate((d) => {
    d.attributes.push({ id, name });
  });
  return id;
}

export function updateAttribute(id: string, patch: Partial<Attribute>): void {
  mutate((d) => {
    const a = d.attributes.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
  });
}

/** Strip an attribute from a requirement list; drop a requirement left empty. */
function stripAttribute<R extends ShiftRequirement | TemplateRequirement>(reqs: R[], id: string): R[] {
  return reqs.filter((r) => {
    if (!r.attributeIds.includes(id)) return true;
    r.attributeIds = r.attributeIds.filter((a) => a !== id);
    return r.attributeIds.length > 0;
  });
}

/** Delete an attribute and every row that references it. */
export function removeAttribute(id: string): void {
  mutate((d) => {
    d.attributes = d.attributes.filter((a) => a.id !== id);
    d.personAttributes = d.personAttributes.filter((pa) => pa.attributeId !== id);
    for (const t of d.shiftTemplates) t.requirements = stripAttribute(t.requirements, id);
    for (const s of d.shifts) s.requirements = stripAttribute(s.requirements, id);
  });
}

// --- Person <-> attribute tags --------------------------------------------

/** Add the tag linking a person to an attribute (no-op if already present). */
export function setPersonAttribute(personId: string, attributeId: string): void {
  mutate((d) => {
    const existing = d.personAttributes.find(
      (pa) => pa.personId === personId && pa.attributeId === attributeId,
    );
    if (!existing) d.personAttributes.push({ personId, attributeId });
  });
}

export function removePersonAttribute(personId: string, attributeId: string): void {
  mutate((d) => {
    d.personAttributes = d.personAttributes.filter(
      (pa) => !(pa.personId === personId && pa.attributeId === attributeId),
    );
  });
}

// --- Person hours (manual mid-season seed) ---------------------------------

/**
 * Upsert the manually-entered hours for a (person, type). Storage is sparse:
 * a zero/blank/negative value clears the row instead of storing it.
 */
export function setPersonHours(personId: string, typeId: string, hours: number): void {
  mutate((d) => {
    const i = d.personHours.findIndex((h) => h.personId === personId && h.typeId === typeId);
    if (!(hours > 0)) {
      if (i >= 0) d.personHours.splice(i, 1);
      return;
    }
    if (i >= 0) d.personHours[i].hours = hours;
    else d.personHours.push({ personId, typeId, hours });
  });
}

/** Replace the entire seeded-hours table at once (used by the autofill tool). */
export function setAllPersonHours(rows: import("./types").PersonHours[]): void {
  mutate((d) => {
    d.personHours = rows.filter((r) => r.hours > 0);
  });
}

/** Patch the persisted seed-autofill settings (end date and/or per-type weights). */
export function updatePrefillSettings(patch: Partial<import("./types").PrefillSettings>): void {
  mutate((d) => {
    Object.assign(d.prefillSettings, patch);
  });
}

// --- Shift types -----------------------------------------------------------

export function addShiftType(name: string): string {
  const id = newId();
  mutate((d) => {
    // Cycle the palette by how many non-default types already exist, so fresh
    // types get distinct, predictable colors.
    const n = d.shiftTypes.filter((t) => t.id !== DEFAULT_SHIFT_TYPE_ID).length;
    const color = SHIFT_TYPE_COLORS[n % SHIFT_TYPE_COLORS.length];
    d.shiftTypes.push({ id, name, color });
  });
  return id;
}

export function updateShiftType(id: string, patch: Partial<ShiftType>): void {
  mutate((d) => {
    const t = d.shiftTypes.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  });
}

/**
 * Delete a shift type. The default type itself cannot be deleted. Shifts and
 * templates of the deleted type fall back to the default — so their *derived*
 * hours roll into the default automatically — and any manually-entered
 * person-hours for the type are merged into each person's default-type row.
 */
export function removeShiftType(id: string): void {
  if (id === DEFAULT_SHIFT_TYPE_ID) return;
  mutate((d) => {
    d.shiftTypes = d.shiftTypes.filter((t) => t.id !== id);
    for (const t of d.shiftTemplates) if (t.typeId === id) t.typeId = DEFAULT_SHIFT_TYPE_ID;
    for (const s of d.shifts) if (s.typeId === id) s.typeId = DEFAULT_SHIFT_TYPE_ID;
    // Merge manual hours of the deleted type into each person's default-type row.
    const moved = d.personHours.filter((h) => h.typeId === id);
    d.personHours = d.personHours.filter((h) => h.typeId !== id);
    for (const m of moved) {
      const existing = d.personHours.find(
        (h) => h.personId === m.personId && h.typeId === DEFAULT_SHIFT_TYPE_ID,
      );
      if (existing) existing.hours += m.hours;
      else d.personHours.push({ personId: m.personId, typeId: DEFAULT_SHIFT_TYPE_ID, hours: m.hours });
    }
  });
}

// --- Shift templates -------------------------------------------------------

/** Create a shift template with sensible defaults; returns its id. */
export function addShiftTemplate(name: string): string {
  const id = newId();
  const now = new Date();
  const anchor = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T09:00:00`;
  mutate((d) => {
    d.shiftTemplates.push({
      id,
      name,
      typeId: DEFAULT_SHIFT_TYPE_ID,
      importance: 1,
      activated: true,
      durationMinutes: 120,
      breakMinutes: 0,
      activationDateTime: anchor,
      frequency: { value: 1, unit: "days" },
      requirements: [],
    });
  });
  return id;
}

export function updateShiftTemplate(id: string, patch: Partial<ShiftTemplate>): void {
  mutate((d) => {
    const s = d.shiftTemplates.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
  });
}

/** Delete a shift template. Its already-expanded instances are left in place. */
export function removeShiftTemplate(id: string): void {
  mutate((d) => {
    d.shiftTemplates = d.shiftTemplates.filter((s) => s.id !== id);
  });
}

// --- Ledger view -----------------------------------------------------------

/** Persist the Ledger timeline window (date-only `from`/`to`, `to` inclusive). */
export function setLedgerView(from: string, to: string): void {
  mutate((d) => {
    d.ledgerView = { from, to };
  });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
