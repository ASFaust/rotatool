/**
 * types.ts — TypeScript types for the model.
 *
 * Persisted-entity types are *inferred* from the Zod schemas in schema.ts, so
 * there is one source of truth. Solver-only I/O types live in src/solver.
 */

import type { z } from "zod";
import type {
  AttributeSchema,
  PersonAttributeSchema,
  PersonSchema,
  AvailabilitySchema,
  ShiftTypeSchema,
  ShiftTemplateSchema,
  TemplateRequirementSchema,
  ShiftSchema,
  ShiftRequirementSchema,
  SolverSettingsSchema,
  LedgerViewSchema,
  MetaSchema,
  AppDataSchema,
} from "./schema";

// --- Persisted entities (inferred from Zod) --------------------------------

export type Attribute = z.infer<typeof AttributeSchema>;
export type PersonAttribute = z.infer<typeof PersonAttributeSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type ShiftType = z.infer<typeof ShiftTypeSchema>;
export type ShiftTemplate = z.infer<typeof ShiftTemplateSchema>;
export type TemplateRequirement = z.infer<typeof TemplateRequirementSchema>;
export type Shift = z.infer<typeof ShiftSchema>;
export type ShiftRequirement = z.infer<typeof ShiftRequirementSchema>;
export type SolverSettings = z.infer<typeof SolverSettingsSchema>;
export type LedgerView = z.infer<typeof LedgerViewSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type AppData = z.infer<typeof AppDataSchema>;
