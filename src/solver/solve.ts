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

/** Solve an LP-format problem in the worker. Rejects on solver/worker error. */
export function solveLP(lp: string, options?: Record<string, unknown>): Promise<HighsLikeSolution> {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { id: number; ok: boolean; solution?: HighsLikeSolution; error?: string };
      if (data.id !== id) return;
      w.removeEventListener("message", onMessage);
      if (data.ok && data.solution) resolve(data.solution);
      else reject(new Error(data.error ?? "solver error"));
    };
    w.addEventListener("message", onMessage);
    w.postMessage({ id, lp, options });
  });
}
