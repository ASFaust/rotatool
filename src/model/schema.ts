/**
 * schema.ts — the single source of truth for Rotatool's data model.
 *
 * Every persisted entity is defined here as a Zod schema; the TypeScript types
 * are *inferred* from these schemas (see types.ts) so there is exactly one
 * definition for both compile-time types and runtime validation.
 *
 * Conventions:
 *  - Entities carry a string `id`, generated internally on import. The .xlsx
 *    workbook references entities by their unique `name` instead; resolving
 *    names <-> ids is persistence's job (persistence/io.ts), not the model's.
 *  - Dates are stored as ISO 8601 strings (date-only `YYYY-MM-DD`, or full
 *    datetime). This keeps the model JSON-serialisable for localStorage. The
 *    expansion/solver layers parse these into absolute `Date` objects when they
 *    need date arithmetic.
 */

import { z } from "zod";

/**
 * Bumped whenever the persisted shape changes. Drives the migrate() chain in
 * persistence/migrate.ts so older workbooks keep loading.
 *
 * v2: ShiftRequirement gained `attributeIds` (ANDed list, was single
 *     `attributeId`) and a `required` flag; handled by a preprocess shim on
 *     the schema itself, so v1 data still parses everywhere.
 */
export const SCHEMA_VERSION = 2;

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
// Shift templates (frequency-based recurrence over real dates)
// ---------------------------------------------------------------------------

export const FrequencyUnit = z.enum(["days", "hours"]);

/**
 * Placement within each recurrence window [anchor + k·freq, anchor + (k+1)·freq):
 *  - strict      pinned to anchor + k·freq exactly (fixed day AND time).
 *  - strictTime  time-of-day pinned; solver picks which day in the window.
 *  - anyTime     solver picks day AND time-of-day in the window.
 */
export const Placement = z.enum(["strict", "strictTime", "anyTime"]);

export const DurationSchema = z.object({
  value: z.number().positive(),
  unit: FrequencyUnit,
});

export const ShiftTemplateSchema = z.object({
  id,
  name: z.string().min(1),
  /** Free-form shift type label (org-defined), used by fairness/preference terms. */
  type: z.string().default(""),
  optional: z.boolean().default(false),
  activated: z.boolean().default(true),
  durationMinutes: z.number().positive(),
  /**
   * Rest period after each occurrence, in minutes. Doesn't count as worked
   * time, but assigning the same person another shift that starts inside it
   * incurs a penalty per violated minute (the `breaks` objective term) — soft
   * blocking, unlike the hard proximity gap. 0 = no break.
   */
  breakMinutes: z.number().nonnegative().default(0),
  /** First occurrence: anchor date + hour:minute. */
  activationDateTime: isoDateTime,
  /** Repeat window width. */
  frequency: DurationSchema,
  placement: Placement,
  /** anyTime candidate-slot spacing; defaults to one candidate/day at anchor time. */
  anyTimeGranularity: DurationSchema.optional(),
});

/**
 * A people slot on a shift: `count` people who each hold *all* of
 * `attributeIds` (empty list = anyone qualifies). A person can occupy only one
 * slot per shift occurrence. `required` makes unfilled seats in this slot a
 * heavy penalty instead of an ordinary coverage shortfall.
 */
export const ShiftRequirementSchema = z.preprocess(
  // v1 shape carried a single `attributeId`.
  (val) => {
    if (val !== null && typeof val === "object" && "attributeId" in val && !("attributeIds" in val)) {
      const { attributeId, ...rest } = val as { attributeId: unknown };
      return { ...rest, attributeIds: [attributeId] };
    }
    return val;
  },
  z.object({
    shiftId: id,
    attributeIds: z.array(id).default([]),
    count: z.number().int().positive(),
    required: z.boolean().default(false),
  }),
);

// ---------------------------------------------------------------------------
// Person preferences + shift preferences
// ---------------------------------------------------------------------------

export const PersonPreferenceSchema = z.object({
  personAId: id,
  personBId: id,
  /** Positive = encourage co-assignment, negative = discourage. */
  weight: z.number(),
});

export const ShiftPreferenceSchema = z.object({
  personId: id,
  shiftType: z.string(),
  dateRangeStart: isoDate.optional(),
  dateRangeEnd: isoDate.optional(),
  /** Positive = preferred, negative = avoided. */
  weight: z.number(),
});

// ---------------------------------------------------------------------------
// Solver settings (toggleable weighted-sum objective + optional constraints)
// ---------------------------------------------------------------------------

/** A single objective term: on/off plus a weight in the weighted sum. */
const Term = z.object({ enabled: z.boolean(), weight: z.number() });

export const SolverSettingsSchema = z.object({
  /**
   * Stop the solve after this many seconds and keep the best roster found so
   * far. Balance-type objectives (fairness, workload) produce long tails of
   * tiny improvements that aren't worth waiting for.
   */
  solveTimeLimitSeconds: z.number().positive().default(30),
  /** Hard constraint: minimum gap between any two shifts for one person. */
  proximityGapMinutes: z.number().nonnegative().default(0),

  coverage: Term.default({ enabled: true, weight: 1 }),
  workload: z
    .object({
      mode: z.enum(["off", "cap", "balance"]),
      weight: z.number(),
    })
    .default({ mode: "off", weight: 1 }),
  /**
   * Relative fairness, independent of `workload` (which measures against each
   * person's absolute target): penalize everyone's L1 deviation from their
   * fair share of the total assigned hours, so load spreads evenly even when
   * the per-person workload is unknown up front. Weight is per hour of
   * deviation — defaults low so coverage stays dominant. `intervalDays`
   * partitions the generation range into windows that are each balanced
   * separately ("be fair every week"), so totals can't be evened out by
   * front-loading one person; 0 balances the whole range at once.
   */
  fairness: z
    .object({
      enabled: z.boolean(),
      weight: z.number(),
      intervalDays: z.number().int().nonnegative().default(7),
    })
    .default({ enabled: false, weight: 0.1, intervalDays: 7 }),
  /**
   * Daily peak ("minimize the maximum overtime ratio"): per day, penalize the
   * highest assigned-hours-to-daily-target ratio across people, so no one gets
   * their shifts clumped into brutal single days. Relative to each person's
   * daily rate (People → hours; people without a target count at the mean), so
   * a 60 h/wk leader's 8-hour day weighs like a 40 h/wk volunteer's 5.7-hour
   * day. Summed over days — every day's worst case counts, not just the
   * range's single worst. Weight is per unit of ratio per day.
   */
  dailyPeak: Term.default({ enabled: false, weight: 1 }),
  /**
   * Breaks after shifts (Shifts → break): penalize each minute of a person's
   * break that another of their shifts eats into. Soft, so a thin roster can
   * still violate a break when nothing else works — weight is per hour of
   * violated break time. Default-enabled: it only bites where a template
   * actually declares a break.
   */
  breaks: Term.default({ enabled: true, weight: 1 }),
  shiftPreferences: Term.default({ enabled: false, weight: 1 }),
  personPreferences: Term.default({ enabled: false, weight: 1 }),
});

// ---------------------------------------------------------------------------
// The Ledger — concrete dated shifts + assignments (timeline of record)
// ---------------------------------------------------------------------------

export const AssignmentStatus = z.enum([
  "autogenerated", // solver-proposed, tentative, freely clearable
  "committed", //     firm/locked; solver treats as fixed and counts toward history
  "performed", //     confirmed reality (post-hoc editable)
]);

export const LedgerShiftSchema = z.object({
  id,
  name: z.string().min(1),
  type: z.string().default(""),
  start: isoDateTime,
  durationMinutes: z.number().positive(),
  /**
   * Solver-owned (`autogenerated`) vs user-owned (`committed`/`performed`).
   * Editing an autogenerated shift promotes it to committed; regeneration only
   * replaces autogenerated shifts. Defaults committed (hand-added / imported).
   */
  status: AssignmentStatus.default("committed"),
  /** Set when generated from a template; absent for ad-hoc one-offs. */
  sourceTemplateId: id.optional(),
});

export const LedgerAssignmentSchema = z.object({
  ledgerShiftId: id,
  personId: id,
  status: AssignmentStatus,
  note: z.string().optional(),
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
  shiftRequirements: z.array(ShiftRequirementSchema).default([]),
  personPreferences: z.array(PersonPreferenceSchema).default([]),
  shiftPreferences: z.array(ShiftPreferenceSchema).default([]),
  solverSettings: SolverSettingsSchema.prefault({}),
  ledgerShifts: z.array(LedgerShiftSchema).default([]),
  ledgerAssignments: z.array(LedgerAssignmentSchema).default([]),
});

/** A fresh, empty dataset stamped with the current schema version. */
export function emptyAppData(): import("./types").AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
  });
}
