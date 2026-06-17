> **⚠ Archived 2026-06-17 — superseded by [ROADMAP.md](../../ROADMAP.md).**
> Original product design, kept for historical intent. Substantially stale:
> xlsx persistence (now JSON), "Ledger" naming, `placement: strict/strictTime/
> anyTime`, and a materialize step that no longer exist.

# Rotatool — a client-side rota generator

## Context

Rotatool helps any organization build balanced staff rotas. A scheduler defines people,
the attributes/roles they hold, recurring shift templates, and the constraints that
matter to them; the tool assigns people to concrete dated shifts via an integer-linear
program, balancing workload, variety, coverage, preferences, and personal tensions.

It must work for many kinds of org, not one: a volunteer field project, a restaurant, a
clinic. So nothing is hardcoded — roles, shift types, and fairness goals are all
user-defined data and toggles.

Design goals:

- **Fully client-side.** Hosted as static files on an existing website; the server serves
  only the UI + algorithm. Sensitive roster data never reaches the server. Users save,
  load, and share their data as downloadable files.
- **Real dates only.** No weekday/weekly logic anywhere; generation always runs over an
  explicit, user-chosen date range.
- **Configurable objectives.** Different orgs optimize for different things (volunteers
  want varied experience; others want everyone working enough hours, or strict caps), so
  the objective is a toggleable weighted sum.
- **Plain, inspectable storage.** A single editable spreadsheet file, so users can open,
  audit, and bulk-edit their data outside the app.

Stack: **Svelte + Vite + TypeScript**, **highs-js** (HiGHS WASM MILP solver) in a Web
Worker, persistence as a **single editable .xlsx workbook** via SheetJS.

## Data model (org-agnostic)

Three layers: **templates** the user edits (recurrence rules), a transient **expansion**
the solver consumes, and the **Ledger** — the persisted timeline of concrete shifts +
assignments that is both the saved rota and the history. Everything is real dates;
generation always requires an explicit date range.

### Attributes unify skills and roles

An **Attribute** is a named person property — a boolean tag (`cook`, `supervisor`,
`first-aid`) or valued (`team=Blue`). Skills, roles, and flags like `leader`/`part-time`
are all attributes. A person *has* attributes; a shift *requires* people with attributes.

- **Attribute**: `id`, `name`, optional `valued: boolean`.
- **PersonAttribute**: `(personId, attributeId, value?)` — boolean tags omit `value`.

### Person

- `id`, `name`, `activated`.
- `hoursPerTimeframe` (optional): `{value, unit: "day"|"week"|"month"}` — target/cap
  workload, used only by whichever workload rule the user enables (see solver settings).
- No leader/part-time/start/leaving/days-off columns — those are attributes (leader,
  part-time) and Availability intervals (stay + absences).

### Availability (positive + negative intervals) — person-level

All absences live at the **person level**, not on the Ledger, because they govern
hour-counting and availability, not the schedule itself.

- **Availability**: `(personId, kind: "available"|"unavailable", start, end?, label?)`.
  A person's stay/employment is one `available` interval (blank `end` = open-ended, for no
  foreseeable leaving date). Free days, vacations, and (retroactive) sick days are
  `unavailable` intervals layered on top — so a long stay needn't be fragmented around
  every day off. Effective availability = union(available) minus union(unavailable). The
  solver forbids assignment whenever a shift isn't inside an available interval or falls
  inside an unavailable one.
- **Reconciliation on commit/regenerate:** when a new `unavailable` interval is added,
  re-running generation (or committing) detects committed Ledger assignments that now
  conflict and surfaces notifications like *"Person removed from shift X (absent DD–DD)"*,
  rather than silently dropping them.

### Shift templates (frequency-based recurrence)

- `id`, `name`, `type`, `optional`, `activated`, `durationMinutes`, and a recurrence:
  - `activationDateTime`: anchor (date + hour:minute) = the first occurrence.
  - `frequency`: a duration `{value, unit: "days"|"hours"}` = the repeat window width.
  - `placement`: `"strict" | "strictTime" | "anyTime"`. Each window is
    `[anchor + k·freq, anchor + (k+1)·freq)` for k = 0,1,2,…:
    - `strict` — occurrence pinned to `anchor + k·freq` exactly (fixed day **and** time).
      e.g. "every Monday 09:00" = anchor on a Monday + 7-day strict; "every day" = 1-day.
    - `strictTime` — time-of-day pinned to the anchor's hour:minute; the solver picks
      **which day** in the window.
    - `anyTime` — the solver picks **day and time-of-day** in the window.
  - `anyTimeGranularity` (optional): candidate-slot spacing for `anyTime`; default one
    candidate per day at the anchor time, overridable (e.g. hourly).

### Shift staffing — requirement slots

A shift is built from **requirement slots**, each "add someone who is an X":

- **ShiftRequirement**: `(shiftId, attributeId, count)` — need `count` people who have
  `attribute`. A restaurant shift = `(cook, n)`, `(supervisor, 1)`, `(clerk, m)`. Total
  headcount = sum of counts. A bare "need N people, no role" is a requirement on a
  sentinel "anyone" attribute everyone has. (Multi-attribute seats — "a cook who is also
  first-aid" — are a later refinement via a requirement-group id; v1 is single-attribute
  per slot.)

### Expansion + animosity

- **ShiftInstance** (transient, not stored): `{id, templateId, start:Date, end:Date,
  requirements, windowGroupId?}`. `expand.ts` materializes templates over the user-chosen
  `[startDate,endDate]` — **purely date arithmetic, no weekday concept**: walk windows `k`
  while the window overlaps the range; per window emit candidates per placement —
  `strict` → one fixed instance; `strictTime` → one candidate per day in the window (same
  time) sharing a `windowGroupId`; `anyTime` → candidates at `anyTimeGranularity` spacing
  sharing a `windowGroupId`. `end = start + durationMinutes`. Absolute Date objects keep
  proximity math working across multi-week ranges.
- **AnimosityPair**: top-level `(personA, personB, weight)`; soft objective penalty per
  (pair, instance) so rosters degrade gracefully rather than going infeasible.

## The Ledger — concrete dated shifts + assignments (timeline of record)

The **Ledger** is the authoritative timeline of **concrete, dated shift instances** and
who is on them. It holds shifts only — **not** personal absences (those are person-level
availability). It is both the historical record and the forward plan, which is what feeds
workload/variety objectives.

- **LedgerShift**: `(id, name, type, start: datetime, durationMinutes, sourceTemplateId?)`
  — a materialized concrete shift. Created by committing expanded template instances over a
  date range, or added ad hoc as a one-off ("plan a shift at this date/time").
- **LedgerAssignment**: `(ledgerShiftId, personId, status, note?)` with
  `status ∈ { autogenerated, committed, performed }`:
  - `autogenerated` — solver-proposed, tentative; freely clearable/regeneratable.
  - `committed` — firm planned assignment (locked); solver treats as **fixed** and counts
    it toward load/history; manual pre-assignments are created directly as `committed`.
  - `performed` — confirmed reality (post-hoc editable: substitution, no-show → remove).

**Flows:**

- *Pre-assign*: place specific people on a Ledger shift before generating; these are
  `committed`/locked and the solver fills the rest.
- *Generate*: "Generate for [date range]" fills unfilled requirement seats on Ledger
  shifts in that range with `autogenerated` assignments, respecting locked ones and
  availability.
- *Commit*: promotes `autogenerated` → `committed` (locked), making them firm and
  history-counting; then the user edits for reality.
- *Regenerate*: a **"Clear all autogenerated future shifts"** button wipes tentative
  `autogenerated` assignments so generation can be re-run cleanly; `committed`/`performed`
  are untouched.
- *History*: prior load per person for workload/variety = `performed` **+** `committed`
  assignments (past and committed-future) read from the Ledger, so someone already booked
  ahead isn't over-loaded.

**Ledger UI** (LedgerView): horizontal axis is time; **no fixed per-person lanes**. Each
shift is a block whose **width ∝ duration** and fixed height; shifts overlapping in time
**stack vertically**, giving a dense "what's running when" view. Each block shows the
shift title and assigned people, color/marker by assignment status.

## Solver (HiGHS MILP in a Web Worker)

Core decision var `x[person, shiftInstance]` (binary). Build a typed model in TS
(variables, linear constraints, objective) and emit it to highs-js running in a Web
Worker so the UI never freezes; post the model in, post the assignment map back. Keep
glpk.js behind the same builder interface as a swappable fallback.

**Hard constraints** (always on):

- Availability: forbid assignment where the instance is outside the person's effective
  availability.
- Proximity: no two shifts within a configurable gap → pairwise `x[a]+x[b] <= 1` using a
  shift overlap + gap test.
- Window-selection groups: per `strictTime`/`anyTime` window, `sum(slot_vars)==1` with
  `x <= slot_var` linking, so exactly one candidate day/slot is chosen.
- Staffing requirements: per instance, per `ShiftRequirement (attribute, count)`,
  `sum over people-with-attribute of x >= count`, plus total headcount
  `sum(x) == sum(counts)`. To avoid one multi-attribute person being counted for several
  requirements, use per-(instance,requirement) seat-assignment vars `s[person,instance,req]`
  with `s <= x`, `sum_person s = count`, each person filling at most one requirement per
  instance — exact seat assignment. (v1 may start with the simpler `>= count` coverage and
  tighten to seat vars; flag in code.)
- Ledger-fixed: `committed`/`performed` Ledger assignments in the generation window fix the
  corresponding `x` (or seat var) to 1; the solver only fills remaining seats.

**Configurable objective + optional constraints** (the user picks per org). A
`SolverSettings` holds toggles + weights for a weighted-sum objective. Terms:

- Total assignments (coverage) — maximize.
- Workload vs `hoursPerTimeframe` — a hard cap or a balancing penalty against target, over
  rolling timeframe windows; or off. Counts **prior load from the Ledger** (`performed` +
  `committed`) plus the shifts being generated.
- Shift-count / shift-type fairness band, or a variety/anti-repetition term; also computed
  against Ledger history.
- Preferences — weighted soft bonus/penalty for a person's preferred/avoided shift types or
  date ranges.
- Animosity — soft penalty per co-assigned pair.
- Consecutive-same-type avoidance — pairwise penalty between same-type shifts ~one window
  apart; weight-controlled.

Each term/constraint is independently toggleable.

## Persistence: single editable .xlsx workbook (the only format)

Use **SheetJS (`xlsx`)** to read/write `.xlsx` entirely client-side. All relationships are
**tidy "long-format" junction sheets — one row per fact** (no comma-lists in cells, no
dynamically-growing columns); the web UI handles bulk editing, so the sheets just need to
be robust and parseable.

- `_meta` — `schemaVersion`, `appVersion`, `exportedAt`.
- `Persons` — name, activated, hoursValue, hoursUnit.
- `Attributes` — name, valued.
- `PersonAttributes` — person, attribute, value (junction; value blank for tags).
- `Availability` — person, kind(available|unavailable), start, end, label.
- `Shifts` — name, type, optional, activated, durationMinutes, activationDateTime,
  frequencyValue, frequencyUnit, placement, anyTimeGranularity.
- `ShiftRequirements` — shift, attribute, count (junction: one row per requirement slot).
- `Animosity` — personA, personB, weight.
- `Preferences` — person, shiftType, dateRangeStart, dateRangeEnd, weight.
- `SolverSettings` — key, value (objective weights + constraint toggles + proximity gap).
- `LedgerShifts` — id, name, type, start (datetime), durationMinutes, sourceTemplate.
- `LedgerAssignments` — ledgerShift, person, status(autogenerated|committed|performed),
  note (junction; this is the stored rota + history).

**Human-friendly references.** Person/Shift/Attribute `name`s are unique, so junction
sheets reference entities **by name**, not opaque ids; ids are generated internally on
import.

**Lenient parsing** (`persistence/io.ts`): case-insensitive + trimmed headers, tolerate
column reordering and extra/missing optional columns, accept flexible booleans
(yes/y/true/1), parse dates leniently. After mapping rows → objects, validate with **zod**
(one source for TS types + runtime validation) and resolve name references; collect errors
and report them per `sheet!cell` with a clear message rather than failing silently.
Unknown sheets/columns are ignored, not fatal.

**Versioning.** `_meta.schemaVersion` drives an ordered `migrate(workbook)` chain
(`v1→v2→…`) applied before validation, so older workbooks keep loading.

Mirror in-memory state to `localStorage`/IndexedDB on every change so a refresh doesn't
lose work; xlsx download/upload is the explicit save/share mechanism. No data leaves the
browser.

## Project structure

```
src/
  model/      types.ts, schema.ts (zod + SCHEMA_VERSION), expand.ts, ledger.ts
              (materialize/commit/clear/reconcile + prior-load), store.ts
  solver/     builder.ts, formulation.ts, highs-adapter.ts, glpk-adapter.ts (fallback),
              worker.ts, solve.ts
  persistence/ io.ts (SheetJS xlsx read/write, lenient parse, name resolution), migrate.ts
  ui/         App.svelte, PeopleView (attributes + availability), AttributesView,
              ShiftsView (recurrence + requirement slots), AnimosityView,
              SolverSettingsView, LedgerView (time-axis blocks, vertical stacking),
              DateRangePicker, components/
  main.ts
public/       highs WASM asset
index.html, package.json, vite.config.ts, tsconfig.json
```

## Sequencing (always a working app each phase)

1. **Scaffold + model + persistence.** Vite+Svelte+TS, `types.ts`/`schema.ts`, `store.ts`
   (localStorage), `io.ts` (SheetJS). Seed workbook. → load/save .xlsx works, with lenient
   parsing and per-cell error reporting.
2. **CRUD views.** People (+ attributes + availability intervals), Attributes, Shifts
   (frequency/placement + requirement slots), Animosity, preferences. Inline-edit + tag UX;
   ids internal, names in the workbook.
3. **Ledger + expansion.** `expand.ts`, `ledger.ts` (materialize concrete shifts from
   templates over a `DateRangePicker` range, ad-hoc shifts, manual pre-assignment),
   `LedgerView` with the time-axis/width∝duration/vertical-stacking layout. → plan and
   hand-assign concrete shifts; save to xlsx.
4. **Solver core.** HiGHS builder + Web Worker; hard constraints (availability, proximity,
   window groups, staffing requirements, Ledger-fixed) and coverage objective; "Generate
   for [range]" writes `autogenerated` assignments into the Ledger; Commit + "clear
   autogenerated future shifts"; availability reconciliation notifications.
5. **Configurable objective terms, one at a time.** `SolverSettings` UI + workload
   (cap/balance, counting Ledger history) → shift-type fairness/variety → preferences →
   animosity → consecutive-same-type, each independently toggleable and re-checked.
6. **Reality + polish.** Mark `performed`/substitution/no-show editing, export
   (CSV/print/calendar), schema-migration tests.

## Verification

- After phase 1: export then re-import an .xlsx workbook; data round-trips; a hand-edited
  workbook (reordered columns, mixed-case headers, a bad cell) loads with the good rows and
  reports the bad cell as `sheet!cell` rather than failing silently.
- After phase 4: build (`vite build`) and confirm the static output loads and solves
  entirely offline (DevTools: no network calls with roster data).
- Staffing check: a shift with `(cook,2),(supervisor,1)` is filled by exactly 3 people, ≥2
  with the cook attribute and ≥1 supervisor; an `unavailable` interval is never assigned;
  an open-ended availability works across the whole range.
- Ledger/commit flow: generate fills only empty seats and leaves manual pre-assignments
  intact; commit locks `autogenerated`→`committed`; re-generating after adding an
  `unavailable` interval surfaces a removal notification; "clear autogenerated future
  shifts" wipes only tentative entries, not committed/performed.
- History: a person with prior `performed`/`committed` Ledger load gets fewer new
  assignments under the workload-balance term; the LedgerView stacks overlapping shifts.
- After each phase 5 term: targeted scenario (workload cap respected; an animosity pair is
  separated or the penalty reflected; preference bonus changes the chosen assignment).
- `npm run build` produces static assets droppable onto the website; smoke-test in a
  browser with the network tab open to confirm nothing sensitive is sent.
