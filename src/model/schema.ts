/**
 * schema.ts — the single source of truth for Rotatool's data model.
 *
 * Every persisted entity is defined here as a Zod schema; the TypeScript types
 * are *inferred* from these schemas (see types.ts) so there is exactly one
 * definition for both compile-time types and runtime validation.
 *
 * Core idea — **field nullability is the solver boundary.** A concrete value is a
 * fixed input; a `null` field is a decision the solver makes. In this phase the
 * only nullable field is who fills a staffing slot (ShiftRequirement.slots).
 *
 * Two shift concepts:
 *  - ShiftTemplate — a *repeating* definition (Shifts tab). Never solved directly;
 *    it is instanced into concrete Shifts over a date range.
 *  - Shift — a *concrete, dated* shift. Covers both one-offs created by hand and
 *    instances expanded from a template (carries `sourceTemplateId` then).
 *
 * Conventions:
 *  - Entities carry a string `id`, generated internally on import.
 *  - Dates are ISO 8601 strings (date-only `YYYY-MM-DD`, or local datetime). The
 *    expansion/solver layers parse these into absolute `Date` objects.
 */

import { z } from "zod";

/** Bumped whenever the persisted shape changes. */
export const SCHEMA_VERSION = 3;

/** Non-empty identifier string (internal id or a name reference). */
const id = z.string().min(1);
/** ISO date-only string, e.g. "2026-06-11". */
const isoDate = z.iso.date();
/** ISO datetime string, e.g. "2026-06-11T09:00". */
const isoDateTime = z.iso.datetime({ local: true });

// ---------------------------------------------------------------------------
// Attributes (unify skills, roles, and flags like leader / part-time)
// ---------------------------------------------------------------------------

/** A named person property: a boolean tag, or a valued attribute (team=Blue). */
export const AttributeSchema = z.object({
  id,
  name: z.string().min(1),
  /** When true the attribute carries a value (e.g. team=Blue); else a boolean tag. */
  valued: z.boolean().default(false),
});

/** Junction: a person *has* an attribute, optionally with a value. */
export const PersonAttributeSchema = z.object({
  personId: id,
  attributeId: id,
  /** Present only for valued attributes; omitted for boolean tags. */
  value: z.string().optional(),
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const HoursUnit = z.enum(["day", "week", "month"]);

export const PersonSchema = z.object({
  id,
  name: z.string().min(1),
  activated: z.boolean().default(true),
  /** Optional workload target/cap; only used by whichever workload rule is enabled. */
  hoursPerTimeframe: z
    .object({ value: z.number().nonnegative(), unit: HoursUnit })
    .optional(),
});

// ---------------------------------------------------------------------------
// Availability (person-level positive/negative intervals)
// ---------------------------------------------------------------------------

export const AvailabilityKind = z.enum(["available", "unavailable"]);

/**
 * An availability interval. Effective availability =
 *   union(available) minus union(unavailable).
 * A blank `end` means open-ended (no foreseeable leaving date).
 */
export const AvailabilitySchema = z.object({
  personId: id,
  kind: AvailabilityKind,
  start: isoDate,
  end: isoDate.optional(),
  label: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Requirements (staffing slots) — embedded in templates and concrete shifts
// ---------------------------------------------------------------------------

/**
 * A staffing requirement on a *template*: `count` people who each hold *all* of
 * `attributeIds` (empty = anyone qualifies). `required` marks the slots as
 * must-fill (heavy coverage penalty) rather than nice-to-have.
 */
export const TemplateRequirementSchema = z.object({
  attributeIds: z.array(id).default([]),
  count: z.number().int().positive(),
  required: z.boolean().default(false),
});

/**
 * A staffing requirement on a *concrete shift*: a group of `slots`, one per
 * needed person. Each slot is `null` (the solver should pick someone) or a
 * `personId` (fixed by hand — the solver treats them as already assigned).
 * `slots.length` is the head-count; `required` is the slot's importance level.
 */
export const ShiftRequirementSchema = z.object({
  attributeIds: z.array(id).default([]),
  required: z.boolean().default(false),
  slots: z.array(z.string().nullable()).default([]),
});

// ---------------------------------------------------------------------------
// Shift templates (repeating definitions — Shifts tab)
// ---------------------------------------------------------------------------

export const FrequencyUnit = z.enum(["days", "hours"]);

export const DurationSchema = z.object({
  value: z.number().positive(),
  unit: FrequencyUnit,
});

export const ShiftTemplateSchema = z.object({
  id,
  name: z.string().min(1),
  /** Free-form shift type label (org-defined), used by fairness/preference terms. */
  type: z.string().default(""),
  /** Coverage weight — how much it matters that this shift is filled (replaces `optional`). */
  importance: z.number().nonnegative().default(1),
  activated: z.boolean().default(true),
  durationMinutes: z.number().positive(),
  /**
   * Rest period after each occurrence, in minutes. Doesn't count as worked time,
   * but assigning the same person another shift inside it is penalized (the
   * `breaks` objective term). 0 = no break.
   */
  breakMinutes: z.number().nonnegative().default(0),
  /** First occurrence: anchor date + hour:minute. */
  activationDateTime: isoDateTime,
  /** Repeat window width. Each window emits one occurrence pinned to its start. */
  frequency: DurationSchema,
  requirements: z.array(TemplateRequirementSchema).default([]),
});

// ---------------------------------------------------------------------------
// Concrete shifts (one-offs + template instances — the timeline of record)
// ---------------------------------------------------------------------------

export const ShiftSchema = z.object({
  id,
  name: z.string().min(1),
  type: z.string().default(""),
  importance: z.number().nonnegative().default(1),
  /** Concrete local datetime of this occurrence. */
  start: isoDateTime,
  durationMinutes: z.number().positive(),
  breakMinutes: z.number().nonnegative().default(0),
  requirements: z.array(ShiftRequirementSchema).default([]),
  /** Set when expanded from a template; absent for hand-created one-offs. */
  sourceTemplateId: id.optional(),
});

// ---------------------------------------------------------------------------
// Solver settings (minimal: coverage + breaks)
// ---------------------------------------------------------------------------

/** A single objective term: on/off plus a weight in the weighted sum. */
const Term = z.object({ enabled: z.boolean(), weight: z.number() });

export const SolverSettingsSchema = z.object({
  /** Stop the solve after this many seconds and keep the best roster found. */
  solveTimeLimitSeconds: z.number().positive().default(30),
  /** Hard constraint: minimum gap between any two shifts for one person. */
  proximityGapMinutes: z.number().nonnegative().default(0),
  /** Fill slots, weighted by each shift's `importance`. */
  coverage: Term.default({ enabled: true, weight: 1 }),
  /** Penalize a person's next shift eating into a declared break. */
  breaks: Term.default({ enabled: true, weight: 1 }),
});

// ---------------------------------------------------------------------------
// Workbook metadata + the aggregate root
// ---------------------------------------------------------------------------

export const MetaSchema = z.object({
  schemaVersion: z.number().int().positive(),
  appVersion: z.string().default("0.0.0"),
  exportedAt: isoDateTime.optional(),
});

/** The complete in-memory dataset — one validated object per workbook. */
export const AppDataSchema = z.object({
  meta: MetaSchema,
  attributes: z.array(AttributeSchema).default([]),
  persons: z.array(PersonSchema).default([]),
  personAttributes: z.array(PersonAttributeSchema).default([]),
  availability: z.array(AvailabilitySchema).default([]),
  shiftTemplates: z.array(ShiftTemplateSchema).default([]),
  solverSettings: SolverSettingsSchema.prefault({}),
  shifts: z.array(ShiftSchema).default([]),
});

/** A fresh, empty dataset stamped with the current schema version. */
export function emptyAppData(): import("./types").AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
  });
}
