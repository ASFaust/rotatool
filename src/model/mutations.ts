/**
 * mutations.ts — small helpers for editing the live dataset.
 *
 * `mutate(fn)` runs a mutator against the store and notifies subscribers. The
 * named helpers cover the operations that need care — chiefly deletes, which
 * must cascade so no reference is left dangling. Concrete-shift operations
 * (instancing, slot assignment) live in ledger.ts.
 */

import { appData, newId } from "./store";
import type { AppData, Person, Attribute, ShiftTemplate, ShiftRequirement, TemplateRequirement } from "./types";

/** Apply an in-place mutation to the dataset and trigger reactivity. */
export function mutate(fn: (data: AppData) => void): void {
  appData.update((data) => {
    fn(data);
    return data;
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
    for (const s of d.shifts)
      for (const r of s.requirements)
        r.slots = r.slots.map((slot) => (slot === id ? null : slot));
  });
}

// --- Attributes ------------------------------------------------------------

export function addAttribute(name: string): string {
  const id = newId();
  mutate((d) => {
    d.attributes.push({ id, name, valued: false });
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

/** Add or update the tag linking a person to an attribute. */
export function setPersonAttribute(personId: string, attributeId: string, value?: string): void {
  mutate((d) => {
    const existing = d.personAttributes.find(
      (pa) => pa.personId === personId && pa.attributeId === attributeId,
    );
    if (existing) existing.value = value;
    else d.personAttributes.push({ personId, attributeId, value });
  });
}

export function removePersonAttribute(personId: string, attributeId: string): void {
  mutate((d) => {
    d.personAttributes = d.personAttributes.filter(
      (pa) => !(pa.personId === personId && pa.attributeId === attributeId),
    );
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
      type: "",
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
