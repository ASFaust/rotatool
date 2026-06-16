/**
 * highs-adapter.ts — thin wrapper around highs-js. Loads the WASM solver once
 * and solves an LP-format string. Used inside the Web Worker (and directly in
 * Node for tests). Keeping the solver behind this interface lets us swap in a
 * glpk.js fallback later without touching the formulation code.
 */

import highsLoader from "highs";
import type { HighsLikeSolution } from "./builder";

type LocateFile = (file: string) => string;
type LogSink = (line: string) => void;

let highsPromise: Promise<{ solve: (lp: string, options?: unknown) => HighsLikeSolution }> | null = null;

// HiGHS routes its stdout through an Emscripten `print` callback fixed at module
// load. We install one forwarder here and point it at whichever solve is in
// flight via this mutable sink (solves are serialized, one at a time).
let logSink: LogSink | null = null;

/** Load (once) and cache the HiGHS module. `locateFile` is required in browsers. */
export function loadHighs(locateFile?: LocateFile) {
  if (!highsPromise) {
    const forward: LogSink = (s) => logSink?.(s);
    highsPromise = highsLoader({
      ...(locateFile ? { locateFile } : {}),
      print: forward,
      printErr: forward,
    } as Parameters<typeof highsLoader>[0]) as Promise<{
      solve: (lp: string, options?: unknown) => HighsLikeSolution;
    }>;
  }
  return highsPromise;
}

/** Solve an LP-format problem and return the HiGHS solution. */
export async function solveLP(
  lp: string,
  locateFile?: LocateFile,
  options?: Record<string, unknown>,
  onLog?: LogSink,
): Promise<HighsLikeSolution> {
  const highs = await loadHighs(locateFile);
  // Presolve stays ON — it is a >10× speedup on realistic rosters. The HiGHS
  // 1.14.2 presolve bug (wrongly pinning continuous auxiliary variables, repro:
  // scripts/presolve-bug.mts) only affects Maximize models; LpBuilder.toLP()
  // always emits Minimize with a negated objective to stay clear of it.
  // output_flag drives the MIP progress log, captured via the print hook above
  // and streamed to the UI; with no onLog it stays silent (no console spam).
  logSink = onLog ?? null;
  try {
    return highs.solve(lp, { output_flag: !!onLog, ...options });
  } finally {
    logSink = null;
  }
}
