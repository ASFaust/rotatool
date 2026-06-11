/**
 * highs-adapter.ts — thin wrapper around highs-js. Loads the WASM solver once
 * and solves an LP-format string. Used inside the Web Worker (and directly in
 * Node for tests). Keeping the solver behind this interface lets us swap in a
 * glpk.js fallback later without touching the formulation code.
 */

import highsLoader from "highs";
import type { HighsLikeSolution } from "./builder";

type LocateFile = (file: string) => string;

let highsPromise: Promise<{ solve: (lp: string, options?: unknown) => HighsLikeSolution }> | null = null;

/** Load (once) and cache the HiGHS module. `locateFile` is required in browsers. */
export function loadHighs(locateFile?: LocateFile) {
  if (!highsPromise) {
    highsPromise = highsLoader(locateFile ? { locateFile } : undefined) as Promise<{
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
): Promise<HighsLikeSolution> {
  const highs = await loadHighs(locateFile);
  // Silence the solver's console output by default.
  return highs.solve(lp, { output_flag: false, ...options });
}
