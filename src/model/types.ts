/**
 * types.ts — TypeScript types for the model.
 *
 * Persisted-entity types are *inferred* from the Zod schemas in schema.ts, so
 * there is one source of truth. This file also defines the transient types that
 * are computed at runtime and never persisted: the template expansion that the
 * solver consumes, and the solver's input/output shapes.
 */

import type { z } from "zod";
import type {
  AttributeSchema,
  PersonAttributeSchema,
  PersonSchema,
  AvailabilitySchema,
  ShiftTemplateSchema,
  ShiftRequirementSchema,
  PersonPreferenceSchema,
  ShiftPreferenceSchema,
  SolverSettingsSchema,
  LedgerShiftSchema,
  LedgerAssignmentSchema,
  MetaSchema,
  AppDataSchema,
} from "./schema";

// --- Persisted entities (inferred from Zod) --------------------------------

export type Attribute = z.infer<typeof AttributeSchema>;
export type PersonAttribute = z.infer<typeof PersonAttributeSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type ShiftTemplate = z.infer<typeof ShiftTemplateSchema>;
export type ShiftRequirement = z.infer<typeof ShiftRequirementSchema>;
export type PersonPreference = z.infer<typeof PersonPreferenceSchema>;
export type ShiftPreference = z.infer<typeof ShiftPreferenceSchema>;
export type SolverSettings = z.infer<typeof SolverSettingsSchema>;
export type LedgerShift = z.infer<typeof LedgerShiftSchema>;
export type LedgerAssignment = z.infer<typeof LedgerAssignmentSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type AppData = z.infer<typeof AppDataSchema>;

export type AssignmentStatus = LedgerAssignment["status"];

// --- Transient expansion types (computed, never persisted) -----------------

/** A concrete people slot on a materialised instance (ids resolved). */
export interface InstanceRequirement {
  /** ANDed attribute ids a person must all hold; empty = anyone qualifies. */
  attributeIds: string[];
  count: number;
  required: boolean;
}

/**
 * A candidate concrete shift produced by expand.ts from a template over a
 * user-chosen date range. Uses absolute `Date` objects so proximity math works
 * across multi-week ranges.
 *
 * For `strictTime`/`anyTime` templates, multiple candidates in the same
 * recurrence window share a `windowGroupId`; the solver picks exactly one.
 */
export interface ShiftInstance {
  id: string;
  templateId: string;
  start: Date;
  end: Date;
  /** Rest period after `end` (template's breakMinutes); soft-blocks the person. */
  breakMinutes: number;
  requirements: InstanceRequirement[];
  /** Present for strictTime/anyTime candidates competing within one window. */
  windowGroupId?: string;
}

// --- Solver I/O (the Web Worker boundary) ----------------------------------

/** What the solver is asked to fill: instances + the fixed assignments. */
export interface SolveRequest {
  instances: ShiftInstance[];
  /** personId -> instanceId pairs locked on (committed/performed). */
  fixed: Array<{ personId: string; instanceId: string }>;
  settings: SolverSettings;
}

export interface SolveResult {
  /** Chosen (personId, instanceId) assignments. */
  assignments: Array<{ personId: string; instanceId: string }>;
  status: "optimal" | "infeasible" | "error";
  message?: string;
}
