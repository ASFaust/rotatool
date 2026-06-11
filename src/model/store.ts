/**
 * store.ts — the live in-memory dataset, mirrored to localStorage.
 *
 * Uses a Svelte writable store (works in plain .ts and is fully reactive in
 * Svelte 5 components). The whole AppData object lives in one store; every
 * change is mirrored to localStorage so a page refresh never loses work. The
 * explicit save/share mechanism is the .xlsx download (see persistence/io.ts);
 * localStorage is just crash protection. Nothing leaves the browser.
 */

import { writable, get } from "svelte/store";
import { AppDataSchema, emptyAppData } from "./schema";
import type { AppData } from "./types";

const STORAGE_KEY = "rotatool:appdata";

/** Load + validate the persisted dataset, falling back to empty on any problem. */
function loadInitial(): AppData {
  if (typeof localStorage === "undefined") return emptyAppData();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyAppData();
    const parsed = AppDataSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    console.warn("Stored data failed validation; starting empty.", parsed.error);
  } catch (err) {
    console.warn("Could not read stored data; starting empty.", err);
  }
  return emptyAppData();
}

/** The single source of live application state. */
export const appData = writable<AppData>(loadInitial());

// Mirror every change back to localStorage.
appData.subscribe((data) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.warn("Could not persist data to localStorage.", err);
  }
});

/** Snapshot of the current dataset (non-reactive read). */
export function getAppData(): AppData {
  return get(appData);
}

/** Replace the entire dataset, e.g. after importing a workbook. */
export function replaceAppData(data: AppData): void {
  appData.set(data);
}

/** Wipe back to an empty dataset. */
export function resetAppData(): void {
  appData.set(emptyAppData());
}

/** Generate a fresh internal entity id. */
export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
