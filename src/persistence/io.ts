/**
 * io.ts — read/write the single editable .xlsx workbook, entirely client-side.
 *
 * The workbook is the explicit save/share format. All relationships are stored
 * as tidy "long-format" junction sheets (one row per fact), and Person / Shift /
 * Attribute references use the entity's unique *name* rather than an opaque id —
 * ids are generated internally on import (LedgerShifts keep an explicit id since
 * many dated shifts can share a name).
 *
 * Reading is deliberately lenient: case-insensitive + trimmed headers, tolerant
 * of reordered / extra / missing optional columns, flexible booleans and dates.
 * Bad rows are skipped and reported as `sheet!cell` errors so the good rows
 * still load. After raw parsing, the assembled object is validated with Zod.
 */

import * as XLSX from "xlsx";
import {
  AppDataSchema,
  SolverSettingsSchema,
  SCHEMA_VERSION,
} from "../model/schema";
import type { AppData, SolverSettings } from "../model/types";
import { newId } from "../model/store";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A problem located at a specific cell, e.g. { sheet:"Persons", cell:"B7" }. */
export interface CellError {
  sheet: string;
  cell: string;
  message: string;
}

export interface ImportResult {
  data: AppData;
  errors: CellError[];
}

/** Thrown by field parsers; carries the offending cell ref + a message. */
class FieldError extends Error {
  constructor(public ref: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Sheet + cell access
// ---------------------------------------------------------------------------

const SHEETS = {
  meta: "_meta",
  persons: "Persons",
  attributes: "Attributes",
  personAttributes: "PersonAttributes",
  availability: "Availability",
  shifts: "Shifts",
  shiftRequirements: "ShiftRequirements",
  animosity: "Animosity",
  preferences: "Preferences",
  solverSettings: "SolverSettings",
  ledgerShifts: "LedgerShifts",
  ledgerAssignments: "LedgerAssignments",
} as const;

function normHeader(h: unknown): string {
  return String(h ?? "").trim().toLowerCase();
}

interface Cell {
  raw: unknown;
  ref: string;
}

interface Row {
  excelRow: number;
  /** Fetch a cell by any of the accepted header aliases (case-insensitive). */
  cell(aliases: string[]): Cell;
}

/** Find the worksheet by name, case-insensitively. */
function findSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet | undefined {
  const target = name.trim().toLowerCase();
  const match = wb.SheetNames.find((n) => n.trim().toLowerCase() === target);
  return match ? wb.Sheets[match] : undefined;
}

/** Turn a worksheet into header-mapped data rows with cell-ref tracking. */
function readRows(ws: XLSX.WorkSheet): Row[] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: undefined,
  });
  if (aoa.length === 0) return [];

  const headers = new Map<string, number>();
  (aoa[0] as unknown[]).forEach((h, i) => {
    const key = normHeader(h);
    if (key !== "" && !headers.has(key)) headers.set(key, i);
  });

  const rows: Row[] = [];
  for (let r = 1; r < aoa.length; r++) {
    const arr = (aoa[r] as unknown[]) ?? [];
    if (arr.every((v) => v == null || v === "")) continue; // skip blank rows
    const excelRow = r + 1;
    rows.push({
      excelRow,
      cell(aliases: string[]): Cell {
        for (const alias of aliases) {
          const ci = headers.get(normHeader(alias));
          if (ci !== undefined) {
            return { raw: arr[ci], ref: XLSX.utils.encode_col(ci) + excelRow };
          }
        }
        return { raw: undefined, ref: `?${excelRow}` }; // column absent
      },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Lenient field parsers (throw FieldError on bad required input)
// ---------------------------------------------------------------------------

function isBlank(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

function optStr(c: Cell): string | undefined {
  if (isBlank(c.raw)) return undefined;
  return String(c.raw).trim();
}

function reqStr(c: Cell, label: string): string {
  const v = optStr(c);
  if (v === undefined) throw new FieldError(c.ref, `${label} is required`);
  return v;
}

const TRUE_SET = new Set(["true", "t", "yes", "y", "1", "x", "✓"]);
const FALSE_SET = new Set(["false", "f", "no", "n", "0", ""]);

function optBool(c: Cell, label: string): boolean | undefined {
  if (isBlank(c.raw)) return undefined;
  if (typeof c.raw === "boolean") return c.raw;
  if (typeof c.raw === "number") return c.raw !== 0;
  const s = String(c.raw).trim().toLowerCase();
  if (TRUE_SET.has(s)) return true;
  if (FALSE_SET.has(s)) return false;
  throw new FieldError(c.ref, `${label} is not a yes/no value: "${c.raw}"`);
}

function optNum(c: Cell, label: string): number | undefined {
  if (isBlank(c.raw)) return undefined;
  const n = typeof c.raw === "number" ? c.raw : Number(String(c.raw).trim());
  if (!Number.isFinite(n)) throw new FieldError(c.ref, `${label} is not a number: "${c.raw}"`);
  return n;
}

function reqNum(c: Cell, label: string): number {
  const n = optNum(c, label);
  if (n === undefined) throw new FieldError(c.ref, `${label} is required`);
  return n;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date as a local (timezone-free) date-only ISO string. */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Format a Date as a local (timezone-free) ISO datetime, seconds precision. */
function fmtDateTime(d: Date): string {
  return `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DATE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;
const TIME_RE = /[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/;

function optDateOnly(c: Cell, label: string): string | undefined {
  if (isBlank(c.raw)) return undefined;
  if (c.raw instanceof Date) return fmtDate(c.raw);
  const s = String(c.raw).trim();
  const m = DATE_RE.exec(s);
  if (!m) throw new FieldError(c.ref, `${label} is not a date (YYYY-MM-DD): "${s}"`);
  return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
}

function reqDateOnly(c: Cell, label: string): string {
  const v = optDateOnly(c, label);
  if (v === undefined) throw new FieldError(c.ref, `${label} is required`);
  return v;
}

function reqDateTime(c: Cell, label: string): string {
  if (isBlank(c.raw)) throw new FieldError(c.ref, `${label} is required`);
  if (c.raw instanceof Date) return fmtDateTime(c.raw);
  const s = String(c.raw).trim();
  const dm = DATE_RE.exec(s);
  if (!dm) throw new FieldError(c.ref, `${label} is not a date/time: "${s}"`);
  const tm = TIME_RE.exec(s);
  const hh = tm ? pad(+tm[1]) : "00";
  const mm = tm ? tm[2] : "00";
  const ss = tm && tm[3] ? tm[3] : "00";
  return `${dm[1]}-${pad(+dm[2])}-${pad(+dm[3])}T${hh}:${mm}:${ss}`;
}

function enumVal<T extends string>(
  c: Cell,
  label: string,
  allowed: readonly T[],
): T {
  const s = reqStr(c, label).toLowerCase();
  const hit = allowed.find((a) => a.toLowerCase() === s);
  if (!hit) throw new FieldError(c.ref, `${label} must be one of ${allowed.join(", ")}: "${s}"`);
  return hit;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A name->id resolver that records an error for unknown names. */
function makeResolver(
  map: Map<string, string>,
  sheet: string,
  errors: CellError[],
) {
  const lower = new Map<string, string>();
  for (const [name, id] of map) lower.set(name.toLowerCase(), id);
  return (c: Cell, label: string): string | undefined => {
    const name = optStr(c);
    if (name === undefined) {
      errors.push({ sheet, cell: c.ref, message: `${label} is required` });
      return undefined;
    }
    const id = lower.get(name.toLowerCase());
    if (id === undefined) {
      errors.push({ sheet, cell: c.ref, message: `Unknown ${label}: "${name}"` });
      return undefined;
    }
    return id;
  };
}

/**
 * Parse a workbook into an AppData object plus a list of per-cell errors.
 * Good rows always load; bad rows are skipped and reported.
 */
export function importWorkbook(input: ArrayBuffer | Uint8Array): ImportResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const errors: CellError[] = [];

  /** Run a per-row handler over a sheet, catching FieldErrors as cell errors. */
  function eachRow(sheetName: string, fn: (row: Row) => void): void {
    const ws = findSheet(wb, sheetName);
    if (!ws) return; // missing sheet is fine
    for (const row of readRows(ws)) {
      try {
        fn(row);
      } catch (err) {
        if (err instanceof FieldError) {
          errors.push({ sheet: sheetName, cell: err.ref, message: err.message });
        } else {
          errors.push({ sheet: sheetName, cell: `?${row.excelRow}`, message: String(err) });
        }
      }
    }
  }

  // --- First pass: name-referenced entities, assigning internal ids ---------
  const attrIdByName = new Map<string, string>();
  const personIdByName = new Map<string, string>();
  const templateIdByName = new Map<string, string>();

  const attributes: AppData["attributes"] = [];
  eachRow(SHEETS.attributes, (row) => {
    const name = reqStr(row.cell(["name"]), "Attribute name");
    const id = newId();
    attrIdByName.set(name, id);
    attributes.push({ id, name, valued: optBool(row.cell(["valued"]), "valued") ?? false });
  });

  const persons: AppData["persons"] = [];
  eachRow(SHEETS.persons, (row) => {
    const name = reqStr(row.cell(["name"]), "Person name");
    const id = newId();
    personIdByName.set(name, id);
    const hoursValue = optNum(row.cell(["hoursvalue", "hours"]), "hoursValue");
    const hoursUnit = optStr(row.cell(["hoursunit", "unit"]));
    persons.push({
      id,
      name,
      activated: optBool(row.cell(["activated", "active"]), "activated") ?? true,
      hoursPerTimeframe:
        hoursValue !== undefined && hoursUnit !== undefined
          ? { value: hoursValue, unit: hoursUnit as "day" | "week" | "month" }
          : undefined,
    });
  });

  const shiftTemplates: AppData["shiftTemplates"] = [];
  eachRow(SHEETS.shifts, (row) => {
    const name = reqStr(row.cell(["name"]), "Shift name");
    const id = newId();
    templateIdByName.set(name, id);
    const granValue = optNum(row.cell(["anytimegranularityvalue", "granularityvalue"]), "anyTimeGranularityValue");
    const granUnit = optStr(row.cell(["anytimegranularityunit", "granularityunit"]));
    shiftTemplates.push({
      id,
      name,
      type: optStr(row.cell(["type"])) ?? "",
      optional: optBool(row.cell(["optional"]), "optional") ?? false,
      activated: optBool(row.cell(["activated", "active"]), "activated") ?? true,
      durationMinutes: reqNum(row.cell(["durationminutes", "duration"]), "durationMinutes"),
      activationDateTime: reqDateTime(row.cell(["activationdatetime", "activation", "anchor"]), "activationDateTime"),
      frequency: {
        value: reqNum(row.cell(["frequencyvalue", "frequency"]), "frequencyValue"),
        unit: enumVal(row.cell(["frequencyunit"]), "frequencyUnit", ["days", "hours"]),
      },
      placement: enumVal(row.cell(["placement"]), "placement", ["strict", "strictTime", "anyTime"]),
      anyTimeGranularity:
        granValue !== undefined
          ? { value: granValue, unit: (granUnit as "days" | "hours") ?? "hours" }
          : undefined,
    });
  });

  // LedgerShifts carry an explicit id (dated shifts aren't name-unique).
  const ledgerShiftIds = new Set<string>();
  const ledgerShifts: AppData["ledgerShifts"] = [];
  eachRow(SHEETS.ledgerShifts, (row) => {
    const id = reqStr(row.cell(["id"]), "LedgerShift id");
    ledgerShiftIds.add(id);
    const srcCell = row.cell(["sourcetemplate", "template"]);
    const srcName = optStr(srcCell);
    let sourceTemplateId: string | undefined;
    if (srcName !== undefined) {
      sourceTemplateId = [...templateIdByName].find(([n]) => n.toLowerCase() === srcName.toLowerCase())?.[1];
      if (!sourceTemplateId) {
        errors.push({ sheet: SHEETS.ledgerShifts, cell: srcCell.ref, message: `Unknown source template: "${srcName}"` });
      }
    }
    const statusCell = row.cell(["status"]);
    ledgerShifts.push({
      id,
      name: reqStr(row.cell(["name"]), "LedgerShift name"),
      type: optStr(row.cell(["type"])) ?? "",
      start: reqDateTime(row.cell(["start"]), "start"),
      durationMinutes: reqNum(row.cell(["durationminutes", "duration"]), "durationMinutes"),
      status: optStr(statusCell)
        ? enumVal(statusCell, "status", ["autogenerated", "committed", "performed"])
        : "committed",
      sourceTemplateId,
    });
  });

  // --- Second pass: junctions referencing the entities above ----------------
  const resolveAttr = makeResolver(attrIdByName, SHEETS.personAttributes, errors);
  const resolvePerson = (sheet: string) => makeResolver(personIdByName, sheet, errors);

  const personAttributes: AppData["personAttributes"] = [];
  eachRow(SHEETS.personAttributes, (row) => {
    const personId = resolvePerson(SHEETS.personAttributes)(row.cell(["person"]), "person");
    const attributeId = resolveAttr(row.cell(["attribute"]), "attribute");
    if (!personId || !attributeId) return;
    personAttributes.push({ personId, attributeId, value: optStr(row.cell(["value"])) });
  });

  const availability: AppData["availability"] = [];
  eachRow(SHEETS.availability, (row) => {
    const personId = resolvePerson(SHEETS.availability)(row.cell(["person"]), "person");
    if (!personId) return;
    availability.push({
      personId,
      kind: enumVal(row.cell(["kind"]), "kind", ["available", "unavailable"]),
      start: reqDateOnly(row.cell(["start"]), "start"),
      end: optDateOnly(row.cell(["end"]), "end"),
      label: optStr(row.cell(["label"])),
    });
  });

  const shiftRequirements: AppData["shiftRequirements"] = [];
  eachRow(SHEETS.shiftRequirements, (row) => {
    const resolveTemplate = makeResolver(templateIdByName, SHEETS.shiftRequirements, errors);
    const shiftId = resolveTemplate(row.cell(["shift"]), "shift");
    const attributeId = makeResolver(attrIdByName, SHEETS.shiftRequirements, errors)(row.cell(["attribute"]), "attribute");
    if (!shiftId || !attributeId) return;
    shiftRequirements.push({ shiftId, attributeId, count: reqNum(row.cell(["count"]), "count") });
  });

  const animosity: AppData["animosity"] = [];
  eachRow(SHEETS.animosity, (row) => {
    const resolve = resolvePerson(SHEETS.animosity);
    const personAId = resolve(row.cell(["persona", "person a", "a"]), "personA");
    const personBId = resolve(row.cell(["personb", "person b", "b"]), "personB");
    if (!personAId || !personBId) return;
    animosity.push({ personAId, personBId, weight: reqNum(row.cell(["weight"]), "weight") });
  });

  const preferences: AppData["preferences"] = [];
  eachRow(SHEETS.preferences, (row) => {
    const personId = resolvePerson(SHEETS.preferences)(row.cell(["person"]), "person");
    if (!personId) return;
    preferences.push({
      personId,
      shiftType: optStr(row.cell(["shifttype", "type"])) ?? "",
      dateRangeStart: optDateOnly(row.cell(["daterangestart", "start"]), "dateRangeStart"),
      dateRangeEnd: optDateOnly(row.cell(["daterangeend", "end"]), "dateRangeEnd"),
      weight: reqNum(row.cell(["weight"]), "weight"),
    });
  });

  const ledgerAssignments: AppData["ledgerAssignments"] = [];
  eachRow(SHEETS.ledgerAssignments, (row) => {
    const shiftRef = row.cell(["ledgershift", "shift", "shiftid"]);
    const shiftId = optStr(shiftRef);
    if (shiftId === undefined || !ledgerShiftIds.has(shiftId)) {
      errors.push({ sheet: SHEETS.ledgerAssignments, cell: shiftRef.ref, message: `Unknown ledgerShift id: "${shiftId ?? ""}"` });
      return;
    }
    const personId = resolvePerson(SHEETS.ledgerAssignments)(row.cell(["person"]), "person");
    if (!personId) return;
    ledgerAssignments.push({
      ledgerShiftId: shiftId,
      personId,
      status: enumVal(row.cell(["status"]), "status", ["autogenerated", "committed", "performed"]),
      note: optStr(row.cell(["note"])),
    });
  });

  // --- SolverSettings (key/value sheet) ------------------------------------
  const settingsFlat: Record<string, unknown> = {};
  eachRow(SHEETS.solverSettings, (row) => {
    const key = optStr(row.cell(["key"]));
    if (key === undefined) return;
    settingsFlat[key] = row.cell(["value"]).raw;
  });
  const solverSettings = parseSolverSettings(settingsFlat, errors);

  // --- Assemble + validate --------------------------------------------------
  const candidate = {
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes,
    persons,
    personAttributes,
    availability,
    shiftTemplates,
    shiftRequirements,
    animosity,
    preferences,
    solverSettings,
    ledgerShifts,
    ledgerAssignments,
  };

  const parsed = AppDataSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ sheet: String(issue.path[0] ?? "?"), cell: issue.path.join("."), message: issue.message });
    }
    // Fall back to whatever validates, so the app still opens.
    return { data: AppDataSchema.parse({ meta: candidate.meta }), errors };
  }
  return { data: parsed.data, errors };
}

/** Rebuild a structured SolverSettings from flat key/value rows. */
function parseSolverSettings(flat: Record<string, unknown>, errors: CellError[]): SolverSettings {
  const obj: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(flat)) {
    const parts = key.split(".");
    let cursor = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] ??= {};
      cursor = cursor[parts[i]] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = raw;
  }
  const parsed = SolverSettingsSchema.safeParse(obj);
  if (parsed.success) return parsed.data;
  errors.push({ sheet: SHEETS.solverSettings, cell: "A1", message: `SolverSettings invalid; using defaults (${parsed.error.issues[0]?.message ?? ""})` });
  return SolverSettingsSchema.parse({});
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Serialise an AppData object to .xlsx bytes (downloadable client-side). */
export function exportWorkbook(data: AppData): Uint8Array {
  const wb = XLSX.utils.book_new();

  const nameOf = <T extends { id: string; name: string }>(arr: T[]) => {
    const m = new Map<string, string>();
    for (const e of arr) m.set(e.id, e.name);
    return (id: string | undefined) => (id === undefined ? "" : m.get(id) ?? "");
  };
  const personName = nameOf(data.persons);
  const attrName = nameOf(data.attributes);
  const templateName = nameOf(data.shiftTemplates);

  const add = (sheetName: string, rows: unknown[][]) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  };

  add(SHEETS.meta, [
    ["key", "value"],
    ["schemaVersion", data.meta.schemaVersion],
    ["appVersion", data.meta.appVersion],
    ["exportedAt", new Date().toISOString()],
  ]);

  add(SHEETS.persons, [
    ["name", "activated", "hoursValue", "hoursUnit"],
    ...data.persons.map((p) => [p.name, p.activated, p.hoursPerTimeframe?.value ?? "", p.hoursPerTimeframe?.unit ?? ""]),
  ]);

  add(SHEETS.attributes, [
    ["name", "valued"],
    ...data.attributes.map((a) => [a.name, a.valued]),
  ]);

  add(SHEETS.personAttributes, [
    ["person", "attribute", "value"],
    ...data.personAttributes.map((pa) => [personName(pa.personId), attrName(pa.attributeId), pa.value ?? ""]),
  ]);

  add(SHEETS.availability, [
    ["person", "kind", "start", "end", "label"],
    ...data.availability.map((a) => [personName(a.personId), a.kind, a.start, a.end ?? "", a.label ?? ""]),
  ]);

  add(SHEETS.shifts, [
    ["name", "type", "optional", "activated", "durationMinutes", "activationDateTime", "frequencyValue", "frequencyUnit", "placement", "anyTimeGranularityValue", "anyTimeGranularityUnit"],
    ...data.shiftTemplates.map((s) => [
      s.name, s.type, s.optional, s.activated, s.durationMinutes, s.activationDateTime,
      s.frequency.value, s.frequency.unit, s.placement,
      s.anyTimeGranularity?.value ?? "", s.anyTimeGranularity?.unit ?? "",
    ]),
  ]);

  add(SHEETS.shiftRequirements, [
    ["shift", "attribute", "count"],
    ...data.shiftRequirements.map((r) => [templateName(r.shiftId), attrName(r.attributeId), r.count]),
  ]);

  add(SHEETS.animosity, [
    ["personA", "personB", "weight"],
    ...data.animosity.map((a) => [personName(a.personAId), personName(a.personBId), a.weight]),
  ]);

  add(SHEETS.preferences, [
    ["person", "shiftType", "dateRangeStart", "dateRangeEnd", "weight"],
    ...data.preferences.map((p) => [personName(p.personId), p.shiftType, p.dateRangeStart ?? "", p.dateRangeEnd ?? "", p.weight]),
  ]);

  add(SHEETS.solverSettings, [["key", "value"], ...flattenSolverSettings(data.solverSettings)]);

  add(SHEETS.ledgerShifts, [
    ["id", "name", "type", "start", "durationMinutes", "status", "sourceTemplate"],
    ...data.ledgerShifts.map((s) => [s.id, s.name, s.type, s.start, s.durationMinutes, s.status, templateName(s.sourceTemplateId)]),
  ]);

  add(SHEETS.ledgerAssignments, [
    ["ledgerShift", "person", "status", "note"],
    ...data.ledgerAssignments.map((a) => [a.ledgerShiftId, personName(a.personId), a.status, a.note ?? ""]),
  ]);

  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

/** Flatten structured SolverSettings into dotted key/value rows. */
function flattenSolverSettings(s: SolverSettings): unknown[][] {
  const rows: unknown[][] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, v);
    } else {
      rows.push([prefix, value]);
    }
  };
  walk("", s);
  return rows;
}

// ---------------------------------------------------------------------------
// Seed data (a small example dataset for first-run / demo / round-trip tests)
// ---------------------------------------------------------------------------

/** Build a tiny restaurant example dataset (validated AppData). */
export function createSeedData(): AppData {
  const cookId = newId();
  const supId = newId();
  const aliceId = newId();
  const bobId = newId();
  const carolId = newId();
  const eveningId = newId();

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
    shiftTemplates: [
      {
        id: eveningId,
        name: "Evening Service",
        type: "service",
        optional: false,
        activated: true,
        durationMinutes: 240,
        activationDateTime: "2026-06-01T17:00:00",
        frequency: { value: 1, unit: "days" },
        placement: "strict",
      },
    ],
    shiftRequirements: [
      { shiftId: eveningId, attributeId: cookId, count: 1 },
      { shiftId: eveningId, attributeId: supId, count: 1 },
    ],
    solverSettings: {},
  });
}
