/**
 * io.ts — save/load the whole dataset as a single JSON file, entirely
 * client-side. This is intentionally minimal: the elaborate per-cell .xlsx
 * importer was dropped during the shift-model rework. A real, org-friendly
 * persistence format (and shift history) is future work — for now JSON gives a
 * lossless round-trip with zero ceremony.
 */

import { AppDataSchema, SCHEMA_VERSION, defaultShiftType } from "../model/schema";
import type { AppData } from "../model/types";
import { newId } from "../model/store";
import { migrate } from "./migrate";

/** A problem encountered while importing (kept for the Overview error list). */
export interface CellError {
  sheet: string;
  cell: string;
  message: string;
}

export interface ImportResult {
  data: AppData;
  errors: CellError[];
}

/** Parse a saved JSON file into AppData. Invalid files fall back to empty. */
export function importWorkbook(input: ArrayBuffer | Uint8Array): ImportResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = new TextDecoder().decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { data: AppDataSchema.parse({ meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" } }), errors: [{ sheet: "file", cell: "-", message: `Not valid JSON: ${err}` }] };
  }
  const parsed = AppDataSchema.safeParse(migrate(raw));
  if (parsed.success) return { data: parsed.data, errors: [] };
  const errors = parsed.error.issues.map((i) => ({ sheet: String(i.path[0] ?? "?"), cell: i.path.join("."), message: i.message }));
  return { data: AppDataSchema.parse({ meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" } }), errors };
}

/** Serialise an AppData object to JSON bytes (downloadable client-side). */
export function exportWorkbook(data: AppData): Uint8Array {
  const out = { ...data, meta: { ...data.meta, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() } };
  return new TextEncoder().encode(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------
// Seed data (a small example dataset for first-run / demo)
// ---------------------------------------------------------------------------

/** Build a tiny restaurant example dataset (validated AppData). */
export function createSeedData(): AppData {
  const cookId = newId();
  const supId = newId();
  const aliceId = newId();
  const bobId = newId();
  const carolId = newId();
  const serviceTypeId = newId();

  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes: [
      { id: cookId, name: "cook", valued: false },
      { id: supId, name: "supervisor", valued: false },
    ],
    persons: [
      { id: aliceId, name: "Alice", activated: true },
      { id: bobId, name: "Bob", activated: true },
      { id: carolId, name: "Carol", activated: true },
    ],
    personAttributes: [
      { personId: aliceId, attributeId: cookId },
      { personId: bobId, attributeId: supId },
      { personId: carolId, attributeId: cookId },
    ],
    availability: [
      { personId: aliceId, kind: "available", start: "2026-01-01" },
      { personId: bobId, kind: "available", start: "2026-01-01" },
      { personId: carolId, kind: "available", start: "2026-01-01" },
    ],
    shiftTypes: [defaultShiftType(), { id: serviceTypeId, name: "service" }],
    shiftTemplates: [
      {
        id: newId(),
        name: "Evening Service",
        typeId: serviceTypeId,
        importance: 1,
        activated: true,
        durationMinutes: 240,
        breakMinutes: 0,
        activationDateTime: "2026-06-01T17:00:00",
        frequency: { value: 1, unit: "days" },
        requirements: [
          { attributeIds: [cookId], count: 1, required: true },
          { attributeIds: [supId], count: 1, required: true },
        ],
      },
    ],
    solverSettings: {},
  });
}
