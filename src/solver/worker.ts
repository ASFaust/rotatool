/**
 * worker.ts — runs HiGHS off the UI thread. Receives an LP string, solves it,
 * posts the solution back. The WASM asset URL is resolved by Vite (?url) and
 * handed to highs-js via locateFile.
 */

import { solveLP } from "./highs-adapter";
import wasmUrl from "highs/runtime?url";

// Typed handle to the worker global without pulling in the WebWorker lib.
const ctx = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
};

interface SolveMessage {
  id: number;
  lp: string;
  options?: Record<string, unknown>;
}

ctx.addEventListener("message", async (e: MessageEvent) => {
  const { id, lp, options } = e.data as SolveMessage;
  try {
    const solution = await solveLP(lp, (file) => (file.endsWith(".wasm") ? wasmUrl : file), options);
    ctx.postMessage({ id, ok: true, solution });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err) });
  }
});
