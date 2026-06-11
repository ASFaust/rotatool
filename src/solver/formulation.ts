/**
 * formulation.ts — turn the dataset + a date range into an LP model, and
 * interpret the solver's answer back into chosen shifts + assignments.
 *
 * Pure (no Web Worker), so it is unit-testable in Node. The worker-driven
 * orchestration lives in generate.ts.
 *
 * Decision variables (v1):
 *  - x[person, instance] binary — person works that occurrence.
 *  - slot[instance] binary, one per candidate in a strictTime/anyTime window
 *    group; exactly one candidate per group is chosen, and x ≤ slot links them.
 *
 * Hard constraints: availability (ineligible person ⇒ no variable), proximity
 * (pairwise mutual exclusion within a gap), window-selection (one slot per
 * group), per-instance headcount cap.
 *
 * Objective (v1): soft coverage — reward filling each requirement up to its
 * count via a capped `filled` term, so an understaffed roster degrades instead
 * of becoming infeasible.
 */

import { LpBuilder } from "./builder";
import type { HighsLikeSolution } from "./builder";
import { expandAll } from "../model/expand";
import { isPersonAvailable } from "../model/ledger";
import type { AppData, ShiftInstance } from "../model/types";

export interface GeneratedShift {
  instanceId: string;
  templateId: string;
  name: string;
  type: string;
  start: string; // local ISO datetime
  durationMinutes: number;
}

export interface GeneratedAssignment {
  instanceId: string;
  personId: string;
}

export interface GenerateResult {
  status: string;
  shifts: GeneratedShift[];
  assignments: GeneratedAssignment[];
  instancesConsidered: number;
}

/** Everything needed to turn a HiGHS solution back into shifts + assignments. */
export interface ModelContext {
  lp: string;
  data: AppData;
  instances: ShiftInstance[];
  /** x variable name -> (person, instance). */
  xVars: Map<string, { personId: string; instanceId: string }>;
  /** instance id -> slot variable name (only for grouped instances). */
  slotVar: Map<string, string>;
}

const pad = (n: number) => String(n).padStart(2, "0");
function fmtLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Two occurrences conflict if they overlap or fall within `gapMs` of each other. */
function inProximity(aStart: number, aEnd: number, bStart: number, bEnd: number, gapMs: number): boolean {
  const latestStart = Math.max(aStart, bStart);
  const earliestEnd = Math.min(aEnd, bEnd);
  if (latestStart < earliestEnd) return true; // overlap
  return latestStart - earliestEnd < gapMs; // gap below threshold
}

/** A person already occupied in a time window (committed/performed elsewhere). */
export interface BusyInterval {
  personId: string;
  start: number;
  end: number;
}

/** Build the LP model for generating a roster over [rangeStart, rangeEnd). */
export function buildModel(
  data: AppData,
  rangeStart: Date,
  rangeEnd: Date,
  busy: BusyInterval[] = [],
): ModelContext {
  const b = new LpBuilder();
  const instances = expandAll(data, rangeStart, rangeEnd);

  // Busy windows per person, so generation never double-books a locked person.
  const busyByPerson = new Map<string, BusyInterval[]>();
  for (const iv of busy) {
    (busyByPerson.get(iv.personId) ?? busyByPerson.set(iv.personId, []).get(iv.personId)!).push(iv);
  }

  // Person -> set of attribute ids (for requirement matching), activated only.
  const attrsByPerson = new Map<string, Set<string>>();
  for (const p of data.persons) {
    if (p.activated) attrsByPerson.set(p.id, new Set());
  }
  for (const pa of data.personAttributes) {
    attrsByPerson.get(pa.personId)?.add(pa.attributeId);
  }

  const xVars = new Map<string, { personId: string; instanceId: string }>();
  // instance id -> map(personId -> x var name), for building constraints.
  const xByInstance = new Map<string, Map<string, string>>();
  const slotVar = new Map<string, string>();
  const coverage: [string, number][] = [];
  const coverageWeight = data.solverSettings.coverage.enabled ? data.solverSettings.coverage.weight : 0;
  const gapMs = data.solverSettings.proximityGapMinutes * 60_000;

  for (const inst of instances) {
    const reqAttrs = new Set(inst.requirements.map((r) => r.attributeId));
    const totalCount = inst.requirements.reduce((s, r) => s + r.count, 0);

    // Eligible people: activated, available at the start, and matching a
    // requirement (or any, if the instance has no requirements).
    const xMap = new Map<string, string>();
    const instS = inst.start.getTime();
    const instE = inst.end.getTime();
    for (const [personId, attrs] of attrsByPerson) {
      if (!isPersonAvailable(data, personId, inst.start)) continue;
      const matches = reqAttrs.size === 0 || [...reqAttrs].some((a) => attrs.has(a));
      if (!matches) continue;
      // Skip if this person is already busy (committed/performed) at this time.
      const conflicts = busyByPerson.get(personId)?.some((iv) => inProximity(instS, instE, iv.start, iv.end, gapMs));
      if (conflicts) continue;
      const v = b.addBinary();
      xMap.set(personId, v);
      xVars.set(v, { personId, instanceId: inst.id });
    }
    xByInstance.set(inst.id, xMap);

    // Headcount cap so the solver never over-staffs.
    if (totalCount > 0 && xMap.size > 0) {
      b.addConstraint([...xMap.values()].map((v) => [v, 1]), "<=", totalCount);
    }

    // Soft coverage: filled[r] <= sum of matching x, rewarded up to count.
    if (coverageWeight > 0) {
      for (const req of inst.requirements) {
        const matchers = [...xMap.entries()]
          .filter(([pid]) => attrsByPerson.get(pid)?.has(req.attributeId))
          .map(([, v]) => v);
        if (matchers.length === 0) continue;
        const filled = b.addContinuous(0, req.count);
        b.addConstraint([[filled, 1], ...matchers.map((v) => [v, -1] as [string, number])], "<=", 0);
        coverage.push([filled, coverageWeight]);
      }
    }
  }

  // Window-selection groups: exactly one candidate per group, x <= slot.
  const groups = new Map<string, ShiftInstance[]>();
  for (const inst of instances) {
    if (inst.windowGroupId) {
      (groups.get(inst.windowGroupId) ?? groups.set(inst.windowGroupId, []).get(inst.windowGroupId)!).push(inst);
    }
  }
  for (const [, members] of groups) {
    const slots: [string, number][] = [];
    for (const inst of members) {
      const slot = b.addBinary();
      slotVar.set(inst.id, slot);
      slots.push([slot, 1]);
      // Link: every x on this instance requires the slot to be chosen.
      for (const v of xByInstance.get(inst.id)!.values()) {
        b.addConstraint([[v, 1], [slot, -1]], "<=", 0);
      }
    }
    b.addConstraint(slots, "=", 1);
  }

  // Proximity: per person, mutually exclude conflicting occurrences. With a gap
  // of 0 this still forbids genuine overlaps.
  const spanById = new Map(instances.map((i) => [i.id, { s: i.start.getTime(), e: i.end.getTime() }]));
  const instancesByPerson = new Map<string, string[]>();
  for (const ref of xVars.values()) {
    (instancesByPerson.get(ref.personId) ?? instancesByPerson.set(ref.personId, []).get(ref.personId)!).push(ref.instanceId);
  }
  for (const [personId, instIds] of instancesByPerson) {
    const xMapFor = (iid: string) => xByInstance.get(iid)!.get(personId)!;
    for (let i = 0; i < instIds.length; i++) {
      for (let j = i + 1; j < instIds.length; j++) {
        const a = spanById.get(instIds[i])!;
        const c = spanById.get(instIds[j])!;
        if (inProximity(a.s, a.e, c.s, c.e, gapMs)) {
          b.addConstraint([[xMapFor(instIds[i]), 1], [xMapFor(instIds[j]), 1]], "<=", 1);
        }
      }
    }
  }

  b.setObjective("max", coverage);
  return { lp: b.toLP(), data, instances, xVars, slotVar };
}

/** Interpret a HiGHS solution against the model context. */
export function interpretSolution(solution: HighsLikeSolution, ctx: ModelContext): GenerateResult {
  const templatesById = new Map(ctx.data.shiftTemplates.map((t) => [t.id, t]));

  // An instance is active if it has no slot (strict) or its slot was chosen.
  const isActive = (inst: ShiftInstance) => {
    const slot = ctx.slotVar.get(inst.id);
    return slot === undefined || LpBuilder.valueOf(solution, slot) === 1;
  };

  const activeInstances = ctx.instances.filter(isActive);
  const activeIds = new Set(activeInstances.map((i) => i.id));

  const shifts: GeneratedShift[] = activeInstances.map((inst) => {
    const t = templatesById.get(inst.templateId);
    return {
      instanceId: inst.id,
      templateId: inst.templateId,
      name: t?.name ?? "Shift",
      type: t?.type ?? "",
      start: fmtLocalDateTime(inst.start),
      durationMinutes: t?.durationMinutes ?? Math.round((inst.end.getTime() - inst.start.getTime()) / 60_000),
    };
  });

  const assignments: GeneratedAssignment[] = [];
  for (const [v, ref] of ctx.xVars) {
    if (!activeIds.has(ref.instanceId)) continue;
    if (LpBuilder.valueOf(solution, v) === 1) {
      assignments.push({ instanceId: ref.instanceId, personId: ref.personId });
    }
  }

  return {
    status: solution.Status,
    shifts,
    assignments,
    instancesConsidered: ctx.instances.length,
  };
}
