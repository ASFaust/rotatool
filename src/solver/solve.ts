/**
 * solve.ts — main-thread entry point to the solver. Spawns the Web Worker
 * lazily, posts an LP string in, resolves with the HiGHS solution. The UI never
 * touches HiGHS directly, so it never blocks on a solve.
 */

import type { HighsLikeSolution } from "./builder";

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

let seq = 0;

// The in-flight request, so cancelSolve() can reject it and kill the worker.
let pending: { id: number; reject: (e: Error) => void } | null = null;

/**
 * Abort the current solve. HiGHS runs synchronously inside the worker and can't
 * be interrupted cleanly, so we terminate the worker outright (a fresh one is
 * spawned lazily next solve) and reject the pending promise with "aborted".
 */
export function cancelSolve(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  if (pending) {
    pending.reject(new Error("aborted"));
    pending = null;
  }
}

/**
 * Solve an LP-format problem in the worker. Rejects on solver/worker error.
 * `onLog` is called for each HiGHS log line as it streams in (live progress).
 */
export function solveLP(
  lp: string,
  options?: Record<string, unknown>,
  onLog?: (line: string) => void,
): Promise<HighsLikeSolution> {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending = { id, reject };
    const settle = (fn: () => void) => {
      pending = null;
      w.removeEventListener("message", onMessage);
      fn();
    };
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { id: number; ok?: boolean; log?: string; solution?: HighsLikeSolution; error?: string };
      if (data.id !== id) return;
      if (data.log !== undefined) {
        onLog?.(data.log);
        return;
      }
      if (data.ok && data.solution) settle(() => resolve(data.solution!));
      else settle(() => reject(new Error(data.error ?? "solver error")));
    };
    w.addEventListener("message", onMessage);
    w.postMessage({ id, lp, options });
  });
}
