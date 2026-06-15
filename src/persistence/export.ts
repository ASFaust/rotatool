/**
 * export.ts — render the Ledger (the rota of record) into shareable formats:
 *  - CSV: one row per assignment (blank person for an unfilled shift), for
 *    spreadsheets / payroll.
 *  - iCalendar (.ics): one VEVENT per shift, assigned people in the description,
 *    importable into Google/Apple/Outlook calendars.
 *  - a print-friendly HTML table (used by the Print button via a popup window).
 *
 * Pure string builders (no DOM), so they are Node-testable; the UI handles the
 * actual download/print. Times are treated as floating local (no timezone), to
 * match how the model stores `start` and how the rest of the app reasons.
 */

import type { AppData, Shift } from "../model/types";

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-01-01T09:00:00" + minutes → "2026-01-01T11:00:00" (local, floating). */
function addMinutesIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Sort shifts chronologically, then by name, for stable export ordering. */
function sortedShifts(data: AppData): Shift[] {
  return [...data.shifts].sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
}

/** People filling a shift's slots, in person-name order (empty slots ignored). */
function assignmentsFor(data: AppData, shift: Shift) {
  const nameById = new Map(data.persons.map((p) => [p.id, p.name]));
  const names: string[] = [];
  for (const r of shift.requirements) for (const pid of r.slots) if (pid) names.push(nameById.get(pid) ?? "?");
  return names.sort((a, b) => a.localeCompare(b));
}

// --- CSV --------------------------------------------------------------------

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function ledgerToCsv(data: AppData): string {
  const header = ["Shift", "Type", "Start", "End", "DurationMinutes", "Person"];
  const rows: string[][] = [];
  for (const s of sortedShifts(data)) {
    const end = addMinutesIso(s.start, s.durationMinutes);
    const people = assignmentsFor(data, s);
    if (people.length === 0) {
      rows.push([s.name, s.type, s.start, end, String(s.durationMinutes), ""]);
    } else {
      for (const name of people) {
        rows.push([s.name, s.type, s.start, end, String(s.durationMinutes), name]);
      }
    }
  }
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

// --- iCalendar --------------------------------------------------------------

/** Local floating timestamp "2026-01-01T09:00:00" → "20260101T090000". */
function icsLocal(iso: string): string {
  return iso.replace(/[-:]/g, "");
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Fold a content line to ≤75 octets per RFC 5545 (continuation lines start with a space). */
function icsFold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 74) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length) parts.push(" " + rest);
  return parts.join("\r\n");
}

export function ledgerToIcs(data: AppData, now: Date = new Date()): string {
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rotatool//Rota//EN",
    "CALSCALE:GREGORIAN",
  ];

  for (const s of sortedShifts(data)) {
    const people = assignmentsFor(data, s);
    const desc =
      (s.type ? `Type: ${s.type}\n` : "") +
      (people.length ? "Assigned: " + people.join(", ") : "Unassigned");

    lines.push(
      "BEGIN:VEVENT",
      icsFold(`UID:${s.id}@rotatool`),
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsLocal(s.start)}`,
      `DTEND:${icsLocal(addMinutesIso(s.start, s.durationMinutes))}`,
      icsFold(`SUMMARY:${icsEscape(s.name)}`),
      icsFold(`DESCRIPTION:${icsEscape(desc)}`),
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// --- Print-friendly HTML ----------------------------------------------------

function htmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

/** A standalone HTML document of the rota, for printing from a popup window. */
export function ledgerToPrintHtml(data: AppData): string {
  const rows = sortedShifts(data)
    .map((s) => {
      const people = assignmentsFor(data, s);
      const who = people.length
        ? people.map((name) => htmlEscape(name)).join(", ")
        : `<span class="unassigned">unassigned</span>`;
      return `<tr><td>${htmlEscape(s.name)}</td><td>${htmlEscape(s.type)}</td><td>${fmtWhen(s.start)}</td><td>${Math.round(s.durationMinutes / 60 * 10) / 10}h</td><td>${who}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Rota</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ccc; vertical-align: top; }
  th { border-bottom: 2px solid #888; }
  .st { color: #666; font-size: 11px; }
  .unassigned { color: #c0392b; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>Rota — ${data.shifts.length} shift(s)</h1>
<table>
  <thead><tr><th>Shift</th><th>Type</th><th>When</th><th>Length</th><th>Assigned</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body></html>`;
}
