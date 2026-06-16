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
export const SCHEMA_VERSION = 7;

/** Non-empty identifier string (internal id or a name reference). */
const id = z.string().min(1);
/** ISO date-only string, e.g. "2026-06-11". */
const isoDate = z.iso.date();
/** ISO datetime string, e.g. "2026-06-11T09:00". */
const isoDateTime = z.iso.datetime({ local: true });

// ---------------------------------------------------------------------------
// Attributes (unify skills, roles, and flags like leader / part-time)
// ---------------------------------------------------------------------------

/** A named person property: a boolean tag (skill, role, flag). */
export const AttributeSchema = z.object({
  id,
  name: z.string().min(1),
});

/** Junction: a person *has* an attribute. */
export const PersonAttributeSchema = z.object({
  personId: id,
  attributeId: id,
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
// Shift types (org-defined categories — Shift Types tab)
// ---------------------------------------------------------------------------

/**
 * Well-known id of the always-present default type. Every shift/template that
 * has no explicit type points here; it can be renamed but never deleted, and
 * deleting any other type reassigns its shifts back to this one.
 */
export const DEFAULT_SHIFT_TYPE_ID = "__default";

/** Neutral grey used for the built-in default shift type. */
export const DEFAULT_SHIFT_TYPE_COLOR = "#9ca3af";

/** Palette new shift types cycle through (distinct, readable hues). */
export const SHIFT_TYPE_COLORS = [
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // amber
  "#dc2626", // red
  "#9333ea", // purple
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
] as const;

/** A named shift category (org-defined), referenced by `typeId` on shifts. */
export const ShiftTypeSchema = z.object({
  id,
  name: z.string().min(1),
  /** Display color (hex), used to tint this type's shifts in the rota grid. */
  color: z.string().default(DEFAULT_SHIFT_TYPE_COLOR),
});

/** A fresh default shift type, seeded into every new dataset. */
export function defaultShiftType(): { id: string; name: string; color: string } {
  return { id: DEFAULT_SHIFT_TYPE_ID, name: "Unassigned", color: DEFAULT_SHIFT_TYPE_COLOR };
}

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
  /** Shift type category (id into `shiftTypes`), used by fairness/preference terms. */
  typeId: id.default(DEFAULT_SHIFT_TYPE_ID),
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
  typeId: id.default(DEFAULT_SHIFT_TYPE_ID),
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
// Person hours (mid-season seed: hours each person already worked, per type)
// ---------------------------------------------------------------------------

/**
 * Manually-entered hours a person had already worked in a shift type *before*
 * the rota was tracked here — the "shift memory" for orgs adopting mid-season.
 * Sparse: only entered (non-zero) rows are stored. The Person Hours tab adds
 * this to hours *derived* from the tracked ledger to get each person's total.
 */
export const PersonHoursSchema = z.object({
  personId: id,
  typeId: id,
  hours: z.number().nonnegative(),
});

/**
 * Persisted settings for the Person Hours "seed autofill" tool: the end date of
 * the simulation and a relative weight per shift type (by id). A type with no
 * entry defaults to weight 1 when the tool runs.
 */
export const PrefillSettingsSchema = z.object({
  endDate: isoDate.optional(),
  weights: z.record(z.string(), z.number().nonnegative()).default({}),
});

// ---------------------------------------------------------------------------
// Solver settings (minimal: coverage + breaks)
// ---------------------------------------------------------------------------

/** A single objective term: on/off plus a weight in the weighted sum. */
const Term = z.object({ enabled: z.boolean(), weight: z.number() });

export const SolverSettingsSchema = z.object({
  /** Stop the solve after this many seconds and keep the best roster found. */
  solveTimeLimitSeconds: z.number().positive().default(30),
  /** Fill slots, weighted by each shift's `importance`. */
  coverage: Term.default({ enabled: true, weight: 1 }),
  /** Penalize a person's next shift eating into a declared break. */
  breaks: Term.default({ enabled: true, weight: 1 }),
  /**
   * Flatten the busiest stretch: penalize (per hour) the heaviest `windowHours`
   * rolling window of assigned work faced by *any* person across the whole
   * range — a min-max that shrinks the single worst stretch anyone works.
   */
  peakWindow: Term.extend({ windowHours: z.number().positive() }).default({
    enabled: false,
    weight: 1,
    windowHours: 24,
  }),
  /**
   * Balance each person's *contribution rate over their tenure*: measure hours
   * (already-worked + newly-assigned) per unit of time the person has been
   * present, scaled by their workload target read as a *relative weight*, and
   * even those rates out. So a longer-tenured person is expected to have done
   * proportionally more, and a half-weight part-timer about half — and only the
   * ratios between targets matter, not the absolute hours entered (a blank target
   * means a full share). `mode` picks the shape: "deviation" pulls the whole
   * roster toward a shared rate (L1); "spread" only squeezes the gap between the
   * busiest and idlest.
   *
   * `perShiftType` runs the balancing once per shift type instead of over total
   * hours — so e.g. nobody ends up doing all the cooking while another does all
   * the kiosk shifts, even if their totals match.
   */
  fairness: Term.extend({ mode: z.enum(["spread", "deviation"]), perShiftType: z.boolean() }).default({
    enabled: false,
    weight: 1,
    mode: "deviation",
    perShiftType: false,
  }),
});

// ---------------------------------------------------------------------------
// Ledger view (persisted timeline range — the "from"/"to" of the Ledger tab)
// ---------------------------------------------------------------------------

/** The date-only window the Ledger timeline shows. `to` is inclusive. */
export const LedgerViewSchema = z.object({
  from: isoDate,
  to: isoDate,
});

/** Default window: today through two weeks out (matches the empty-workbook view). */
function defaultLedgerView(): { from: string; to: string } {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + 13);
  return { from: fmt(today), to: fmt(end) };
}

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
  shiftTypes: z.array(ShiftTypeSchema).default(() => [defaultShiftType()]),
  shiftTemplates: z.array(ShiftTemplateSchema).default([]),
  solverSettings: SolverSettingsSchema.prefault({}),
  shifts: z.array(ShiftSchema).default([]),
  /** Manually-seeded hours per person per type (mid-season "shift memory"). */
  personHours: z.array(PersonHoursSchema).default([]),
  /** Persisted Ledger timeline window. */
  ledgerView: LedgerViewSchema.default(defaultLedgerView),
  /** Persisted settings for the Person Hours seed-autofill tool. */
  prefillSettings: PrefillSettingsSchema.prefault({}),
});

/** A fresh, empty dataset stamped with the current schema version. */
export function emptyAppData(): import("./types").AppData {
  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
  });
}
