/**
 * generate.ts — drive a people-assignment end to end: build the LP from the
 * concrete shifts in a range, solve it in the worker, and write the chosen
 * people into the empty slots.
 *
 * This is **phase 3** (assign). Shifts must already have been planned and
 * instanced into the range (phase 1/2). The solver only fills empty slots;
 * hand-assigned slots are held fixed. Re-running therefore only fills what's
 * still open — clear slots first (clearAssignmentsInRange) to redo from scratch.
 */

import { getAppData } from "../model/store";
import { mutate } from "../model/mutations";
import { buildAssignmentModel, interpretSolution } from "./formulation";
import type { AssignResult } from "./formulation";
import { solveLP } from "./solve";

export interface AssignSummary {
  status: string;
  seatsFilled: number;
  seatsConsidered: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
function fmtLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function assignPeople(rangeStart: Date, rangeEnd: Date): Promise<AssignSummary> {
  const data = getAppData();
  const startStr = fmtLocalDateTime(rangeStart);
  const endStr = fmtLocalDateTime(rangeEnd);
  const shifts = data.shifts.filter((s) => s.start >= startStr && s.start < endStr);

  const ctx = buildAssignmentModel(data, shifts);
  const s = ctx.stats;
  console.log(
    `[rotatool] assign: ${ctx.seatsConsidered} open seats, ${s.binaries} binaries, ` +
      `${s.continuous} continuous, ${s.constraints} constraints, ${s.nonzeros} nonzeros`,
  );
  const solution = await solveLP(ctx.lp, {
    time_limit: data.solverSettings.solveTimeLimitSeconds,
    mip_rel_gap: 0.01,
  });
  return applyAssignments(interpretSolution(solution, ctx));
}

/** Write solved seat assignments into still-empty slots. Separated for testing. */
export function applyAssignments(result: AssignResult): AssignSummary {
  let seatsFilled = 0;
  mutate((d) => {
    const byId = new Map(d.shifts.map((s) => [s.id, s]));
    for (const a of result.assignments) {
      const r = byId.get(a.shiftId)?.requirements[a.reqIndex];
      if (r && r.slots[a.slotIndex] === null) {
        r.slots[a.slotIndex] = a.personId;
        seatsFilled++;
      }
    }
  });
  return { status: result.status, seatsFilled, seatsConsidered: result.seatsConsidered };
}
