/**
 * dates.ts — display formatting for dates and datetimes.
 *
 * The whole app shows dates in `dd/mm/yyyy`. We pin the `en-GB` locale (rather
 * than the visitor's system locale) so the format is identical on every machine.
 * Native `<input type="date">` controls still follow the browser's own locale —
 * only rendered/derived text goes through these helpers.
 */

const LOCALE = "en-GB";

/** A date or datetime ISO string → `dd/mm/yyyy`. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** A datetime ISO string → `Wdy dd/mm/yyyy, HH:MM` (weekday optional). */
export function formatDateTime(iso: string, opts: { weekday?: boolean } = {}): string {
  return new Date(iso).toLocaleString(LOCALE, {
    weekday: opts.weekday ? "short" : undefined,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
