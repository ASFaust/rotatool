/**
 * history.ts — undo/redo over the live dataset, backed by JSON diffs.
 *
 * Every edit funnels through `mutate()` (mutations.ts), which hands us the
 * before/after states straddling one commit; we store the round-trip as a pair
 * of RFC-6902 patches (fast-json-patch). Undo applies the reverse patch, redo
 * the forward one. Patches are tiny, so deep history costs almost nothing —
 * far cheaper than cloning the whole AppData per step.
 *
 * No "are we applying history?" guard is needed: recording happens *only* inside
 * `mutate()`. Undo/redo write straight through `appData.set`, so they never feed
 * back into `recordCommit`. Whole-dataset replacements (import / load example /
 * clear) call `resetHistory()` — you can't undo across a different dataset.
 *
 * History is in-memory only; a page refresh starts with an empty stack (the
 * data itself survives via localStorage, see store.ts).
 */

// fast-json-patch's ESM entry only exposes a default export at runtime (its
// .d.ts advertises named exports that index.mjs doesn't actually provide), so
// pull the functions off the default and the Operation type separately.
import fastJsonPatch from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import { writable, get } from "svelte/store";

const { compare, applyPatch } = fastJsonPatch;
import { appData } from "./store";
import type { AppData } from "./types";

interface Step {
  /** Patch turning the post-edit state back into the pre-edit state. */
  undo: Operation[];
  /** Patch re-applying the edit. */
  redo: Operation[];
}

const undoStack: Step[] = [];
const redoStack: Step[] = [];
const MAX_DEPTH = 100; // cap memory; drop the oldest beyond this

/** Reactive flags for button enable/disable. */
export const canUndo = writable(false);
export const canRedo = writable(false);

function sync(): void {
  canUndo.set(undoStack.length > 0);
  canRedo.set(redoStack.length > 0);
}

/** Record one committed edit. Called by `mutate()` with both states. */
export function recordCommit(before: AppData, after: AppData): void {
  const redo = compare(before, after);
  if (redo.length === 0) return; // no-op edit → nothing to record
  const undo = compare(after, before);
  undoStack.push({ undo, redo });
  if (undoStack.length > MAX_DEPTH) undoStack.shift();
  redoStack.length = 0; // a fresh edit invalidates the redo branch
  sync();
}

function apply(ops: Operation[]): void {
  const next = applyPatch(structuredClone(get(appData)), ops).newDocument as AppData;
  appData.set(next); // bypasses mutate ⇒ not re-recorded; still mirrored to localStorage
}

/** Revert the most recent edit. */
export function undo(): void {
  const step = undoStack.pop();
  if (!step) return;
  apply(step.undo);
  redoStack.push(step);
  sync();
}

/** Re-apply the most recently undone edit. */
export function redo(): void {
  const step = redoStack.pop();
  if (!step) return;
  apply(step.redo);
  undoStack.push(step);
  sync();
}

/** Clear all history (used on whole-dataset replacement). */
export function resetHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  sync();
}
