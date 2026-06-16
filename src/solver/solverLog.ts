/**
 * solverLog.ts — the shared, navigation-proof state of the most recent (or
 * in-flight) HiGHS solve, plus the orchestration that drives a run.
 *
 * The run lives here rather than in a component because the tabs unmount on
 * switch: if the Ledger view owned the timer/progress, leaving the tab would
 * lose them mid-solve. Both the Ledger tab (progress + abort) and the Solver
 * tab (full scrolling log) read this one store, and the run keeps going while
 * you browse elsewhere.
 *
 * HiGHS streams a MIP progress log line-by-line through the worker (see
 * highs-adapter's print hook). We keep the raw lines for the "window into the
 * solver" and best-effort parse the optimality gap so the UI can show how close
 * the solver is to its mip_rel_gap target. The progress *bar* is driven by
 * elapsed/time-limit — the gap is nonlinear and only a hint.
 */

import { writable, get } from "svelte/store";
import { getAppData } from "../model/store";
import { assignPeople, type AssignSummary } from "./generate";
import { cancelSolve } from "./solve";

export interface SolverRun {
  /** True while a solve is in flight. */
  running: boolean;
  /** ms timestamps (Date.now). */
  startedAt: number | null;
  finishedAt: number | null;
  /** The time limit the run was launched with, for the progress bar. */
  timeLimitSec: number;
  /** Whole seconds since start, ticked once a second while running. */
  elapsedSec: number;
  /** Raw HiGHS log lines (capped). */
  lines: string[];
  /** Best-effort optimality gap as a fraction (0.038 = 3.8%), or null. */
  gap: number | null;
  /** Final HiGHS status string once finished (e.g. "Optimal"), else null. */
  status: string | null;
  /** Human-readable outcome line shown after the run, with guidance. */
  message: string;
}

const MAX_LINES = 1000;

function empty(): SolverRun {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    timeLimitSec: 0,
    elapsedSec: 0,
    lines: [],
    gap: null,
    status: null,
    message: "",
  };
}

export const solverRun = writable<SolverRun>(empty());

let ticker: ReturnType<typeof setInterval> | null = null;
function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * Run an assignment end to end, owning the store lifecycle: clear the log,
 * start the clock, stream HiGHS output, and record the outcome. Safe to call
 * from a component — the run survives that component unmounting. No-ops if a
 * solve is already running.
 */
export async function runAssign(rangeStart: Date, rangeEnd: Date): Promise<void> {
  if (get(solverRun).running) return;
  const timeLimitSec = getAppData().solverSettings.solveTimeLimitSeconds;

  solverRun.set({ ...empty(), running: true, startedAt: Date.now(), timeLimitSec });
  stopTicker();
  ticker = setInterval(() => {
    solverRun.update((r) => {
      if (!r.running || r.startedAt === null) return r;
      return { ...r, elapsedSec: Math.round((Date.now() - r.startedAt) / 1000) };
    });
  }, 1000);

  try {
    const r = await assignPeople(rangeStart, rangeEnd, appendLog);
    finish(r.status, assignAdvice(r));
  } catch (e) {
    if (e instanceof Error && e.message === "aborted") {
      finish("Aborted", "Solve aborted — open slots were left untouched.");
    } else {
      finish("Error", "Assign failed: " + (e instanceof Error ? e.message : e));
    }
  }
}

/** Abort the in-flight solve (terminates the worker; see cancelSolve). */
export function abortRun(): void {
  if (get(solverRun).running) cancelSolve();
}

/** Append one HiGHS log line, parsing the gap out of it when present. */
function appendLog(line: string): void {
  const gap = parseGap(line);
  solverRun.update((r) => {
    const lines = r.lines.length >= MAX_LINES ? [...r.lines.slice(-(MAX_LINES - 1)), line] : [...r.lines, line];
    return { ...r, lines, gap: gap ?? r.gap };
  });
}

function finish(status: string, message: string): void {
  stopTicker();
  solverRun.update((r) => ({ ...r, running: false, finishedAt: Date.now(), status, message }));
}

/** Turn a solver result into an outcome line with guidance when it fell short. */
function assignAdvice(r: AssignSummary): string {
  const filled = `filled ${r.seatsFilled} of ${r.seatsConsidered} open slot(s)`;
  const open = r.seatsConsidered - r.seatsFilled;
  if (r.status === "Time limit reached") {
    return open > 0
      ? `Stopped at the time limit — ${filled}. ${open} still open: increase the solve time limit (Solver tab) or narrow the date range.`
      : `Stopped at the time limit but ${filled} — roster may not be optimal. Raise the time limit for a tighter result.`;
  }
  if (r.status === "Infeasible") {
    return `No valid assignment exists — ${filled}. Relax requirements, eligibility, or availability, or hand-assign the tight slots.`;
  }
  if (open > 0 && (r.status === "Optimal" || r.status === "Empty")) {
    return `${r.status}: ${filled}. The remaining ${open} can't be filled by anyone eligible & available — check requirements/people.`;
  }
  return `${r.status}: ${filled}.`;
}

/**
 * Best-effort gap extraction from a HiGHS log line, as a fraction.
 *
 * Two shapes carry it: the final "Solving report" line (`Gap  3.8% (tolerance:
 * 1%)` — the tolerance trailing % is why we anchor on the leading "Gap") and
 * the periodic MIP progress rows, which end in an elapsed time like "2.1s" and
 * whose last percentage column is the gap (the earlier % is tree "Expl.").
 */
function parseGap(line: string): number | null {
  const report = line.match(/^\s*Gap\s+([\d.]+)%/);
  if (report) return Number(report[1]) / 100;
  if (/[\d.]+s\s*$/.test(line)) {
    const pcts = [...line.matchAll(/([\d.]+)%/g)];
    if (pcts.length >= 2) return Number(pcts[pcts.length - 1][1]) / 100;
  }
  return null;
}
