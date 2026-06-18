/**
 * io.ts — save/load the whole dataset as a single JSON file, entirely
 * client-side. This is intentionally minimal: the elaborate per-cell .xlsx
 * importer was dropped during the shift-model rework. A real, org-friendly
 * persistence format (and shift history) is future work — for now JSON gives a
 * lossless round-trip with zero ceremony.
 */

import { AppDataSchema, SCHEMA_VERSION } from "../model/schema";
import type { AppData } from "../model/types";
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
