/**
 * migrate.ts — forward-migrate a persisted dataset to the current schema shape
 * *before* it is validated. The app has exactly one validated in-memory shape
 * (the current `AppDataSchema`); older saved files are reshaped here so they
 * still load losslessly instead of failing validation and falling back to empty.
 *
 * Each step is a pure `unknown -> unknown` transform keyed by source version.
 * Steps are defensive: on any unexpected shape they return the input untouched
 * and let Zod's `safeParse` produce the usual fallback + error list.
 */

import { SCHEMA_VERSION, DEFAULT_SHIFT_TYPE_ID, DEFAULT_SHIFT_TYPE_COLOR, SHIFT_TYPE_COLORS } from "../model/schema";
import { newId } from "../model/store";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read `meta.schemaVersion` if present and numeric, else undefined. */
function versionOf(raw: unknown): number | undefined {
  if (!isObj(raw) || !isObj(raw.meta)) return undefined;
  const v = raw.meta.schemaVersion;
  return typeof v === "number" ? v : undefined;
}

/**
 * v3 → v4: shift "type" went from a free-form string on each template/shift to a
 * first-class `ShiftType` entity referenced by `typeId`. Mint one type per
 * distinct non-empty string (empty → the default type) and rewrite references.
 */
function v3ToV4(raw: Obj): Obj {
  const templates = Array.isArray(raw.shiftTemplates) ? raw.shiftTemplates : [];
  const shifts = Array.isArray(raw.shifts) ? raw.shifts : [];

  // Map a distinct type *name* to a minted type id (the default name maps to the
  // default id so old empty/Unassigned shifts collapse onto the built-in type).
  const idByName = new Map<string, string>();
  const shiftTypes: { id: string; name: string }[] = [{ id: DEFAULT_SHIFT_TYPE_ID, name: "Unassigned" }];
  idByName.set("unassigned", DEFAULT_SHIFT_TYPE_ID);

  const typeIdFor = (value: unknown): string => {
    const name = typeof value === "string" ? value.trim() : "";
    if (name === "") return DEFAULT_SHIFT_TYPE_ID;
    const key = name.toLowerCase();
    let mapped = idByName.get(key);
    if (!mapped) {
      mapped = newId();
      idByName.set(key, mapped);
      shiftTypes.push({ id: mapped, name });
    }
    return mapped;
  };

  const rewrite = (entity: unknown): unknown => {
    if (!isObj(entity)) return entity;
    const { type, ...rest } = entity;
    return { ...rest, typeId: typeIdFor(type) };
  };

  return {
    ...raw,
    shiftTypes,
    shiftTemplates: templates.map(rewrite),
    shifts: shifts.map(rewrite),
    meta: { ...(isObj(raw.meta) ? raw.meta : {}), schemaVersion: 4 },
  };
}

/**
 * v4 → v5: add the `personHours` seed array (manual hours per person per type).
 * Purely additive — old datasets simply start with no seeded hours.
 */
function v4ToV5(raw: Obj): Obj {
  return {
    ...raw,
    personHours: Array.isArray(raw.personHours) ? raw.personHours : [],
    meta: { ...(isObj(raw.meta) ? raw.meta : {}), schemaVersion: 5 },
  };
}

/**
 * v5 → v6: add `prefillSettings` (the Person Hours seed-autofill tool's end
 * date + per-type weights). Purely additive — defaults are filled on parse.
 */
function v5ToV6(raw: Obj): Obj {
  return {
    ...raw,
    prefillSettings: isObj(raw.prefillSettings) ? raw.prefillSettings : {},
    meta: { ...(isObj(raw.meta) ? raw.meta : {}), schemaVersion: 6 },
  };
}

/**
 * v6 → v7: attributes lost the `valued` flag (and `personAttributes` their
 * `value`) — they are now plain boolean tags — and shift types gained a `color`.
 * Stripping the dropped keys is handled by Zod; here we backfill a color per
 * type so old types render with distinct hues instead of all-default grey.
 */
function v6ToV7(raw: Obj): Obj {
  const palette = SHIFT_TYPE_COLORS;
  let i = 0;
  const types = Array.isArray(raw.shiftTypes) ? raw.shiftTypes : [];
  const shiftTypes = types.map((t) => {
    if (!isObj(t)) return t;
    if (typeof t.color === "string") return t;
    const color = t.id === DEFAULT_SHIFT_TYPE_ID ? DEFAULT_SHIFT_TYPE_COLOR : palette[i++ % palette.length];
    return { ...t, color };
  });
  return {
    ...raw,
    shiftTypes,
    meta: { ...(isObj(raw.meta) ? raw.meta : {}), schemaVersion: 7 },
  };
}

/**
 * v7 → v8: the fairness term was reworked from a relative-ratio model to a
 * history-aware target-deviation one. `mode` changed values ("deviation" → "L1",
 * "spread" → "min-max") and a `maxCatchUpHours` ramp cap was added. Map the old
 * mode and backfill the cap; Zod drops anything else that no longer fits.
 */
function v7ToV8(raw: Obj): Obj {
  const ss = isObj(raw.solverSettings) ? raw.solverSettings : {};
  const f = isObj(ss.fairness) ? ss.fairness : {};
  const mode = f.mode === "spread" ? "min-max" : "L1"; // "deviation"/absent → L1
  return {
    ...raw,
    solverSettings: {
      ...ss,
      fairness: {
        ...f,
        mode,
        maxCatchUpHours: typeof f.maxCatchUpHours === "number" ? f.maxCatchUpHours : 40,
      },
    },
    meta: { ...(isObj(raw.meta) ? raw.meta : {}), schemaVersion: 8 },
  };
}

/**
 * v8 → v9: the timeline-of-record was renamed from "ledger" to "rota" throughout.
 * The only persisted field affected is the saved date window, `ledgerView` →
 * `rotaRange` (same `{from, to}` shape). Rename it if present; Zod backfills the
 * default otherwise.
 */
function v8ToV9(raw: Obj): Obj {
  const { ledgerView, ...rest } = raw;
  return {
    ...rest,
    ...(isObj(ledgerView) ? { rotaRange: ledgerView } : {}),
    meta: { ...(isObj(raw.meta) ? raw.meta : {}), schemaVersion: 9 },
  };
}

/** Ordered migration steps; index by the *source* version they upgrade from. */
const STEPS: Record<number, (raw: Obj) => Obj> = {
  3: v3ToV4,
  4: v4ToV5,
  5: v5ToV6,
  6: v6ToV7,
  7: v7ToV8,
  8: v8ToV9,
};

/**
 * Bring a parsed-but-unvalidated dataset up to the current schema version by
 * running each step in sequence. Unknown/garbage input is returned untouched.
 */
export function migrate(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  try {
    let current: Obj = raw;
    let version = versionOf(current);
    while (typeof version === "number" && version < SCHEMA_VERSION && STEPS[version]) {
      current = STEPS[version](current);
      version = versionOf(current);
    }
    return current;
  } catch {
    return raw;
  }
}
