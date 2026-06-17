# Rotatool — Roadmap to public release

The single source of truth for **what remains to be done** before Rotatool can be
published officially. Written 2026-06-17 on branch `shift-rework`; supersedes the
"what's next" sections of `PROGRESS.md` and `plan.md` (now archived — see
[Document status](#document-status) at the bottom for which older docs are stale).

This is a feature/work roadmap, not a design spec. For *why* the model looks the
way it does, see the design notes in [docs/notes/](docs/notes/).

---

## Where things stand today

The app is a working, fully client-side rota generator (Svelte 5 + Vite + TS,
HiGHS WASM MILP in a Web Worker, persistence as a single `.json` file). The
current shape, for grounding the work below:

- **Tabs:** Overview · People · Shifts · **Rota**. ([src/App.svelte](src/App.svelte))
  - **Shifts** sub-tabs: *Recurring shifts* · *One-time shifts* · *Shift types*.
  - **Rota** sub-tabs: *Timeline* · *Grid* · *Solver*.
- **Shift model is "all-strict" right now.** A `ShiftTemplate` has only an anchor
  (`activationDateTime`) + a `frequency` window width; **each window emits exactly
  one occurrence pinned to the window start** — there is no flexible placement.
  ([src/model/schema.ts](src/model/schema.ts), `ShiftTemplateSchema`). The old
  `placement: strict | strictTime | anyTime` field was removed in this rework.
  "One-time shifts" are concrete `Shift` rows, edited on a separate sub-tab.
- **"Ledger" is still the internal name** for the timeline-of-record: `LedgerView`,
  `model/ledger.ts`, the `"ledger"` tab id, `generate.ts`, etc. (~16 files mention
  it). User-facing copy already says "Rota".
- Generate runs one solve that places template occurrences *and* assigns people,
  on the Timeline. Assignment controls currently live on both Timeline and Grid.
- Schema is at `SCHEMA_VERSION = 8`; fairness was reworked to history-aware
  per-person hour targets (done — [docs/archive/fairness_rework.md](docs/archive/fairness_rework.md)).

---

## The work

Roughly ordered; the shift-model rework (1) and the two-stage solve (2) are the
big ones and are coupled. Solver polish (6) is the gate on release.

### 1. Unify the shift editor (recurring · weekdays · any-time)

Collapse the *Recurring shifts* / *One-time shifts* split into **one shift
editor**. Every shift has a **start date**; the rest is progressive disclosure
driven by a **`recurring` checkbox**:

- **Not recurring** → a one-time shift at the given date + time. (Replaces the
  separate One-time shifts tab.)
- **Recurring** → reveal the extra fields:
  - **Repeat every** — the frequency window (the field that exists today).
  - **End date** — *new*; bounds the recurrence (today recurrence is open-ended /
    range-bounded only).
  - **Weekday selection** — *new*; restrict occurrences to chosen days of week
    (e.g. Mon–Fri only, skip weekends).
  - **Any-time checkbox** — *new*; see (1a) below.

**1a. "Any-time" (floating) shifts — one of the biggest items.** When *recurring*
is checked, an **any-time** option makes each occurrence floating: it must happen
*somewhere* in its interval (`[start, start+repeat-every)` up to the end date)
rather than pinned to the window start. Floating shifts add **two time-of-day
fields** — the daily window the shift may be performed in (e.g. "grocery shopping,
once a week, Mon–Sat, between 11:00 and 18:00"). Choosing the concrete day + time
becomes a **solver decision** (this is why item 2 exists).

> Note: this re-introduces (and generalises) the `strictTime` / `anyTime`
> placement that was cut in the current rework — but now driven by plain checkboxes
> + weekday + time-of-day window instead of a `placement` enum.

Touches: `ShiftTemplateSchema` (+ migration), the Shifts views
([RecurringShiftsView.svelte](src/ui/RecurringShiftsView.svelte) /
[OneTimeShiftsView.svelte](src/ui/OneTimeShiftsView.svelte) merge into one),
`expand.ts` (emit candidate slots for floating occurrences), the solver.

### 2. Two-stage solve: place, then assign

When there are any floating ("any-time") shifts, generation becomes **two
optimizations**:

1. **Placement** — a new ILP that decides *when* each floating occurrence happens
   within its interval / time-of-day window (respecting weekdays).
2. **Assignment** — the existing solve that puts people on the now-concrete shifts.

If there are no floating shifts, stage 1 is a no-op (today's behaviour). All of
this happens on the **Timeline** tab — it becomes the single place where placement
*and* assignment occur.

Touches: `formulation.ts` / `generate.ts` (new placement model + sequencing),
`worker.ts`, the Timeline view.

### 3. Make Timeline the workflow hub

The intended flow: **start on Timeline → place shifts → assign people**, all in one
view.

- **Move all assignment controls to Timeline.** Remove them from the **Grid** tab
  — Grid becomes display/export only. ([LedgerView.svelte](src/ui/LedgerView.svelte),
  which currently renders both via a `mode` prop.)
- **Double-click to add a shift.** Double-clicking an empty spot on the Timeline
  creates a **new one-time shift** at the clicked day + hour (editable afterwards).

### 4. Rename "ledger" → timeline / grid / rota everywhere

Keep the three Rota sub-tabs (*Timeline*, *Grid*, *Solver*). **The word "ledger"
must not appear anywhere in the project** — not in code identifiers, file names,
comments, or UI. Use *timeline*, *grid*, or *rota* as appropriate.

Touches: `LedgerView.svelte`, `model/ledger.ts`, `LedgerShift` / `LedgerAssignment`
types, the `"ledger"` tab id in `App.svelte`, and the ~16 files that reference it
(`grep -ril ledger src`). The archived [ledger-generate-loop.md](docs/archive/ledger-generate-loop.md) keeps the old name for history.

### 5. Export & the A4 print editor

- **Export buttons move off Timeline.** They live **only on Grid** — the grid is
  the main export format.
- **New rota print editor** — a new page/screen that lays the rota grid out across
  a tiling of **A4 pages** with sensible seams, scaling, and pagination, so a large
  rota prints cleanly across multiple sheets. This is a substantial new surface.

### 6. Solver / optimizer polish (release gate)

Some optimizer behaviour is "garbage-ish" and needs work **before** an official
release — **fairness and shift balancing especially** may need a rethink. They're
acceptable for now but not release-quality. (The history-aware fairness rework in
[docs/archive/fairness_rework.md](docs/archive/fairness_rework.md) is a foundation, not
the finish line.) Expect this to be its own focused pass.

Known solver pain points already documented in [PROGRESS.md](docs/archive/PROGRESS.md) worth
folding into this pass: balance terms competing on the shared hour layer flatten
the search landscape on month-long ranges (fairness + dailyPeak + breaks plateau
below coverage-optimum); candidate fix is a two-stage coverage-then-balance solve.

### 7. Small UI polish

Quick, mostly-cosmetic items (all in [src/App.svelte](src/App.svelte) unless
noted):

- **GitHub link on the Overview page** — link out to the project repo.

### 8. Built-in examples cleanup

The bundled examples ([src/persistence/examples.ts](src/persistence/examples.ts),
spec in [example.md](example.md)) need to be generic and shippable:

- **Remove the ARCHELON / Rethymno branding** — keep the scenario shape (a
  multi-shift seasonal field project is a good stress test) but strip the
  real-organisation name and place. Rename `example.md` accordingly.
- **Remove the "Alice & Bob" simple cook rota** example.
- **Add examples for other kinds of org/schedule** — e.g. a restaurant, a clinic,
  a small shop — to show the tool isn't single-purpose.

### 9. Pre-launch / outreach

- **Set up a contact email** for correspondence (bug reports, feedback) and surface
  it in the app/README.
- **Record a short YouTube walkthrough** showcasing the tool, and link it from the
  Overview page / README.

### 10. Avoidance rules (general "cooldown" constraints)

We need a way to discourage things like *back-to-back morning surveys* — but
expressed **generically**, never hardcoded for one org (no "Archelon morning
survey" special case). The mechanism is a new, addable rule type:

> **"Avoid assigning `[shift or shift type]` for `[N hours]` after `[shift or
> shift type]`."**

- Either side can be a **concrete shift** or a **shift type**, so it covers both
  one-off and recurring cases.
- A rule is a **soft penalty with a weight** (not a hard ban) so the solver can
  break it when coverage demands — same philosophy as the other balance terms.
- The motivating example (don't do two early surveys in a row) falls out of a
  type→type rule with the shift's own type on both sides; nothing org-specific.

Touches: `schema.ts` (new rule entity + migration), a small editor surface for
the rule list (likely under Shifts or a constraints area), and the solver
objective in `builder.ts` / `formulation.ts` (penalty terms keyed on the time gap
between assignments of the named shifts/types for the same person).

### 11. People preferences (weighted, signable)

A new **Preferences** sub-tab under the **People** tab for soft, per-person
preferences that feed the solver objective. Each preference carries a **weight
`z` that may be negative** (negative = aversion / "avoid"):

- **Person → shift type** — "person X prefers shift type Y, weight z."
- **Person ↔ person** — "person X prefers working with person Y, weight z"
  (co-assignment on the same shift / overlapping time).

These are soft terms, balanced against fairness and coverage like everything else.

Touches: `schema.ts` (preference entities + migration), a new
`PreferencesView.svelte` wired into `peopleTabs` in [src/App.svelte](src/App.svelte)
alongside Directory / Attributes / Person Hours, and new objective terms in
`builder.ts` / `formulation.ts` (per-assignment bonus for shift-type prefs;
pairwise bonus for people who share a shift).

---

## Document status

Stale docs were moved to **[docs/archive/](docs/archive/)** on 2026-06-17, each
with a dated "superseded" banner. Kept docs and what they are:

- **[example.md](example.md)** — the ARCHELON test scenario; current, fine as-is.
- **[docs/archive/README.md](docs/archive/README.md)** — *archived.* Was the
  default Vite/Svelte template boilerplate, never customized. A real project README
  still needs writing before release.
- **[docs/archive/plan.md](docs/archive/plan.md)** — *archived.* Original product
  design. Substantially stale: xlsx persistence (now JSON), "Ledger" naming,
  `placement: strict/strictTime/anyTime`, and a materialize step that no longer
  exist. Historical design intent only.
- **[docs/archive/PROGRESS.md](docs/archive/PROGRESS.md)** — *archived.* Dev handoff,
  technically rich but pre-rework in places. Trust the code over it.
- **[docs/notes/dev-environment.md](docs/notes/dev-environment.md)** — current.
- **[docs/archive/fairness_rework.md](docs/archive/fairness_rework.md)** —
  *archived.* The fairness rework shipped 2026-06-17; its "Resolution (as built)"
  section documents the current fairness implementation. Further polish in item 6.
- **[docs/archive/ledger-generate-loop.md](docs/archive/ledger-generate-loop.md)** —
  *archived.* Substantially stale: describes the removed `autogenerated/committed/
  performed` status model and auto-lock generate/regenerate loop.
