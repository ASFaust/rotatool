# Rotatool — development state / handoff

A living record of where development stands, so work can resume in a fresh
session. For the full product design, see [plan.md](plan.md). This file covers
**what is built, how it's structured, key decisions, and what's next.**

---

> **⚠ Doc drift (branch `shift-rework`, 2026-06-15).** A model rework is underway:
> the status enum, flexible placements, and preference/workload/fairness solver
> terms were removed. The model is now field-nullability based — a `Shift` has
> requirement `slots: (personId|null)[]`; `null` slots are the only solver
> variables. Three phases: plan (Shifts tab) → instance+adjust (Ledger) → assign
> (solver). Persistence is now plain JSON (xlsx dropped). The phase notes below
> and plan.md describe the **old** design — trust the code and the
> `ledger-generate-loop-design` memory over them until they're rewritten.

## TL;DR

A client-side rota generator: define people / attributes / shift templates →
**Generate** → a HiGHS MILP solver (in a Web Worker) fills a concrete dated
timeline you can hand-edit. Saves/loads a single `.xlsx`. Fully offline.

**Phases 1–5 are done and verified. Phase 6 remains.**

---

## Environment & commands

Node is managed via **nvm**. Every shell that runs `npm`/`node` must source nvm
and select Node ≥ 20.19 (Vite 6+ requires it; on the current laptop the nvm
`default` is v22):

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
```

See [docs/notes/dev-environment.md](docs/notes/dev-environment.md). Note: a
passing `npm run check` does **not** prove the toolchain is healthy — old Node
type-checks fine but crashes on `npm run build`/`npm run dev`.

Then:

| Command | What |
|---|---|
| `npm run dev` | Vite dev server (hot reload) at http://localhost:5173 |
| `npm run build` | Production build to `dist/` (static, droppable on any host) |
| `npm run check` | `svelte-check` + `tsc` type-check (keep at 0 errors / 0 warnings) |
| `npm run preview` | Serve the production build locally |

**Stack:** Svelte 5 (runes) + Vite + TypeScript · `zod` (validation) · `xlsx`
(SheetJS, persistence) · `highs` (HiGHS WASM MILP solver).

**Verification pattern used during dev:** for pure logic, write a throwaway
`scripts/*.mts` and run it with `TZ=Europe/Berlin npx tsx scripts/x.mts`, then
delete it. For browser/worker behavior, build + `npm run preview` + drive
headless `google-chrome --headless --remote-debugging-port=…` over the DevTools
Protocol (CDP via Node's global `WebSocket`). Nothing test-framework-based is
committed yet (Phase 6 adds real tests).

---

## Git / branches

Phases 1–4 were each developed on a stacked branch, then merged to **master**,
which now holds the full rewrite through Phase 4 (the old Flask prototype is
gone). The `phase-*` branches survive on `origin` for history. `HEAD` is at the
"Copy working notes into repo" commit.

New work should branch off `master`. Commit messages end with the
`Co-Authored-By: Claude …` trailer. Commit only when asked.

---

## Phase status

- [x] **Phase 1 — scaffold + model + persistence.** Vite/Svelte/TS, zod model,
      reactive store mirrored to localStorage, lenient `.xlsx` read/write with
      per-cell error reporting, seed data.
- [x] **Phase 2 — CRUD views.** People (attributes + availability), Attributes,
      Shifts (recurrence + requirement slots), Animosity, Preferences. Tabbed
      shell. Inline editing; cascade-on-delete.
- [x] **Phase 3 — expansion + Ledger.** `expand.ts` (DST-safe template →
      instances), `ledger.ts`, time-axis `LedgerView` (width ∝ duration,
      vertical stacking), hand-assignment, availability-conflict banner.
- [x] **Phase 4 — solver + Generate/regenerate.** HiGHS MILP in a worker; hard
      constraints + soft coverage; Generate/Commit/Clear; auto-lock-on-edit.
- [x] **Phase 5 — configurable objective terms.** `SolverSettingsView` (Solver
      tab) with toggle + weight per term; `formulation.ts` wires workload
      (off/cap/balance), shift-type fairness, variety, preferences, animosity,
      and consecutive-same-type — each independently toggleable and verified
      with a `scripts/*.mts` scenario. Surfaced & fixed a HiGHS presolve bug (see
      Gotchas).
- [x] **Fairness (spread) objective** (added 2026-06-11).
      `solverSettings.fairness` penalizes each person's L1 deviation from their
      fair share of the *total* assigned hours — relative balancing for dynamic
      workloads, complementing `workload` (absolute target cap/balance); the
      two are independent and combinable. Shares = available days in range ×
      target rate where set (people without a target count at the mean target
      rate). The ARCHELON example ships with it on: leaders 60 h/wk carry 1.5×
      a volunteer's 40 h/wk share — verified 30d spread collapses from
      2.6–8.9 h/day to 5.3–5.7 (volunteers) / ~8.4 (leaders). Because balance
      terms have a long tail of tiny MIP improvements, Generate now solves with
      `solveTimeLimitSeconds` (new setting, default 30 s, returns incumbent) +
      1% `mip_rel_gap`. Scenario proof: `npx tsx scripts/fairness.mts`.
- [x] **People slots + clique proximity** (added 2026-06-11). Staffing rework:
      a `ShiftRequirement` is now a *people slot* — `{ attributeIds (ANDed,
      empty = anyone), count, required }` (SCHEMA_VERSION=2; v1 single
      `attributeId` shapes migrate via a preprocess shim on the zod schema, so
      old localStorage/workbooks/scripts all still parse). Formulation: per-row
      seat vars `y[p,row]` with `x = Σ y` (aliased to x when a person matches
      one row) kill the old multi-attribute double-counting *and* replace the
      headcount cap; `required` rows add a soft-but-dominant shortfall penalty
      (1000× coverage, slot-gated for window groups) so unfillable seats degrade
      instead of going infeasible. `seatAssignmentExact` (never implemented) is
      removed. Proximity was 71% of all constraints (12.5k of 17.6k, ARCHELON
      30d) as pairwise exclusions; now one Σx ≤ 1 per *maximal clique* of each
      person's interval graph (inflate by gap/2 → sweep), 1.7k constraints and a
      tighter relaxation. 30d coverage: timeout → optimal ~6s (presolve off);
      30d full (fairness on): finds 622.36 vs 623 coverage-optimum in 20s with
      presolve on (off still struggles — fairness's dense rows are the remaining
      bottleneck). `LpBuilder.stats()` now includes a per-kind constraint census
      (`addConstraint(..., kind)`), printed by `scripts/example-archelon.mts`.
      Scenario proofs: `scripts/people-slots.mts`, `scripts/proximity-cliques.mts`.
      ARCHELON example: universal "crew" attribute dropped (anyone-slots), MS
      leader/driver/presenter seats marked required.
- [x] **Day-subtotal layer + dailyPeak + weekly fairness** (added 2026-06-11).
      Motivated by a real roster flaw: month-level fairness happily gave Lukas
      MS survey + cooking + presentation in one 14h day. New shared layer:
      `h[p,d]` = minutes person p works day d (one short equality row each);
      workload, fairness and the new term all read these, so their rows are
      sparse. **fairness.intervalDays** (default 7, 0 = whole range) balances
      each week separately. **dailyPeak** = "minimize the maximum overtime
      ratio": per day, an aux ≥ every person's assigned-minutes ÷ daily-rate
      (per-mille int/continuous), penalized summed over days — a per-day
      minimax, so one forced-bad day doesn't blind the term elsewhere (a single
      global max would). Rates from People → hours; fallback when nobody has a
      target is 8 h/day for the peak ratio (absolute scale) vs mean-rate for
      fairness (relative shares). Verified: ARCHELON 30d person-days >12h drop
      34 → 9, worst day 15h → 12h. Scenario proof: `scripts/daily-peak.mts`.
      Two bugs found on the way: fairness `total`/`dev` upper bounds computed
      from term *coefficients* instead of minute UBs (silently zeroed every
      roster), and the integer-aux convention itself (see updated presolve
      gotcha) — declaring the ~510 h vars integer stalled all 30d incumbents.
      **Known limitation:** fairness + dailyPeak *together* on 30d plateau at
      ~580/623 seats in 30–45s (each alone reaches 623). Not fixable by time
      (45s = identical incumbent), heuristic effort, or required-weight scaling
      (all tested); the two terms competing on the shared h layer flatten the
      search landscape. Fine at ≤7d ranges; for month ranges use one term or
      raise the time limit. Breaks (2026-06-12) as a *third* soft term makes
      the 30d plateau worse still (~377 incumbent at 60s vs ~541 for
      fairness+peak alone; any *two* of the three land ~530–580), while
      coverage+breaks without balance terms is optimal in ~13s — same advice
      as above, only more so. Candidate future fix: two-stage solve (coverage +
      required first, then re-solve hour terms with coverage fixed).
- [x] **Breaks after shifts** (added 2026-06-12). `ShiftTemplate.breakMinutes`
      reserves a rest period after each occurrence — *soft* blocking: it never
      counts as worked hours, but giving the same person another shift that
      starts inside it costs the violated minutes via the new `breaks`
      objective term (default-enabled; weight per violated hour). Motivating
      cases, both wired into the ARCHELON example: late-night presentation →
      no 05:00 morning survey (presentations break 480), and no back-to-back
      kiosk shifts (kiosk break 60). Formulation: per (person, break) one aux
      var ≥ each follower's violated minutes — the *worst* cut, not the sum
      (the break effectively ends at the earliest violating start), and one
      var per break instead of one binary per pair (pairwise z was >half the
      30d model; 17.9k → 9.4k binaries). Single-follower breaks use a binary z
      to dodge the continuous objective-singleton presolve bug. Committed/
      performed busy intervals carry `breakMs` and penalize candidates
      directly, in both directions (their break onto a candidate, a
      candidate's break onto them). On the way, surfaced a real LP-writer bug:
      the HiGHS LP *reader does not sum duplicate variable entries* ("v0 +
      0.5 v0" parses as 0.5·v0), so coverage + a positive shift preference on
      the same seat had silently *replaced* the coverage reward — fmtExpr in
      builder.ts now coalesces duplicates. Scenario proof (steering, anyTime
      placement dodging the break window, both busy directions, and the
      off-baselines that caught the duplicate bug): `npx tsx scripts/breaks.mts`.
      7d full roster: violated break minutes 2340 → 0 with the term on. 30d:
      coverage+breaks alone solves *optimal* in ~13s, but as a third balance
      term it deepens the fairness+dailyPeak plateau (see that gotcha).
- [ ] **Phase 6 — reality + polish** (next). performed/substitution/no-show
      editing, export (CSV/print/calendar), schema-migration + solver tests.

---

## Architecture / file map

```
src/
  model/
    schema.ts      zod schemas = single source of truth; SCHEMA_VERSION=1;
                   inferred types live in types.ts. emptyAppData().
    types.ts       TS types (inferred) + transient ShiftInstance / solver I/O.
    store.ts       Svelte writable `appData` mirrored to localStorage;
                   getAppData/replaceAppData/resetAppData/newId.
    mutations.ts   mutate(fn) + entity add/update/remove with cascade-on-delete.
    expand.ts      expandAll(data,start,end) → ShiftInstance[]; pure date math,
                   calendar-day stepping for day-frequencies (DST-safe);
                   strictTime/anyTime emit grouped candidates (windowGroupId).
    ledger.ts      availability check + reconcile; ad-hoc shifts; assign/status
                   with auto-lock (promote); busyIntervals; clear/commit
                   autogenerated; priorLoad (committed+performed history).
  solver/
    builder.ts     LpBuilder: typed model → CPLEX LP text; valueOf(solution).
    formulation.ts buildModel(data,range,busy) → {lp, …}; interpretSolution().
                   Hard: availability/proximity-cliques/window-groups/people-slot
                   capacity + workload cap. Objective = coverage + weighted
                   penalties (required-seat shortfall, workload balance,
                   fairness, preferences), each read from solverSettings.
    highs-adapter.ts  loadHighs()/solveLP() — wraps highs-js WASM. Presolve ON;
                   the 1.14.2 presolve bug is dodged structurally (see Gotchas).
    worker.ts      Web Worker: LP in → solution out; WASM via Vite ?url.
    solve.ts       main-thread solveLP() that talks to the worker.
    generate.ts    generateRoster(range): build→solve→applyGeneration(ledger).
  persistence/
    io.ts          SheetJS read/write; lenient parse; name↔id resolution;
                   per-cell errors; createSeedData(). 12 tidy long sheets.
  ui/
    App.svelte         tab shell + file actions (import/save/load example/clear).
    PeopleView, AttributesView, ShiftsView, AnimosityView, PreferencesView,
    SolverSettingsView (toggle + weight per objective term, proximity gap),
    LedgerView (timeline + Generate/Commit/Clear + detail/assign panel),
    DateRangePicker.svelte
  main.ts, app.css   (app.css holds theme vars + shared .view/.btn/.tag styles)
public/  favicon.svg   (HiGHS .wasm is bundled by Vite from node_modules)
```

---

## Key design decisions (and why)

- **zod is the single source of truth.** Types are inferred from schemas; one
  definition for compile-time + runtime. Bump `SCHEMA_VERSION` + add a migration
  only for breaking shape changes (a new defaulted field needs neither).
- **Dates are local ISO strings** in the model (JSON/localStorage-safe). Parsed
  to `Date` only in expand/solver. Day-unit recurrences step by **calendar
  days** so wall-clock time survives DST (verified). Ranges are half-open
  `[start, end)`; the UI passes end = midnight-after the chosen end date.
- **Entities carry internal ids; the workbook references by unique name.**
  Resolution happens in `io.ts`. (LedgerShifts keep an explicit id since many
  dated shifts share a name.)
- **No "materialize" step.** Only `strict` shifts have a fixed occurrence;
  `strictTime`/`anyTime` day/time is a solver decision, so you can't materialize
  them pre-solve. Instead: one **Generate** makes shifts *and* assignments.
- **Generate / edit / regenerate loop** (supersedes plan.md's materialize text;
  see memory `ledger-generate-loop-design`):
  - Generate writes `autogenerated` shifts + assignments over a range.
  - **Editing anything on an autogenerated shift auto-locks the whole shift**
    (shift + its assignments → `committed`).
  - Regenerate clears autogenerated-in-range, keeps committed/performed, treats
    their people as **busy** (no double-book), and skips shifts coinciding with
    a committed one (no duplicates).
- **Soft coverage** (maximize filled seats up to required count) instead of a
  hard `>= count` staffing constraint, so short-staffing degrades gracefully
  instead of going infeasible. (Old Flask code made it hard.) `required` people
  slots follow the same philosophy: a dominant soft penalty, not a hard
  constraint, so the solver always returns a roster the UI can flag.

---

## Known v1 simplifications (deliberate; refine later)

Andreas plans to refine these in a separate conversation:

1. **Auto-lock granularity is the whole shift**, not the individual seat.
   Editing one assignment locks the entire shift. Per-seat locking needs
   seat-assignment vars.
2. **Committed shifts aren't refilled by regenerate.** The plan's "pre-assign,
   then solver fills remaining seats" (ledger-fixed seat filling) is deferred.
3. ~~**Coverage double-counts multi-attribute people**~~ — fixed by the people-
   slots formulation (2026-06-11): per-row seat vars with `x = Σ y` mean one
   person occupies exactly one slot per occurrence.
4. **Workload targets are scaled over the whole generation range**, not rolling
   per-timeframe windows — `40h/week` over a 2-week range = an 80h budget for the
   range, not a check per calendar week. `cap` = hard ceiling; `balance` only
   penalizes hours *above* target (doesn't reward hitting it).
5. **Consecutive-same-type uses a 1.5× smallest-frequency window per type** to
   decide "adjacent," rather than per-template recurrence pairing.

---

## Next: Phase 6 (reality + polish)

Phase 5 is done — all objective terms in `SolverSettings` are wired into
`formulation.ts` (each reads its enabled/weight from `data.solverSettings`) and
exposed in the **Solver** tab. The objective is `coverage + Σ penalties`; mind
term scaling so coverage stays dominant (required-seat shortfalls are scaled
1000× coverage and must stay on top).

Remaining for Phase 6:

- **Reality editing** — mark assignments `performed`, substitutions, no-show →
  remove (the status already exists; `LedgerView` needs the UI).
- **Export** — CSV / print / calendar (.ics) views of the Ledger.
- **Tests** — schema-migration tests and solver tests. The `scripts/*.mts`
  scenarios from Phase 5 (workload / fairness-variety / preferences / animosity /
  consecutive) are the obvious seeds to formalize into a real test runner.

Each Phase-5 term was verified with a throwaway `scripts/*.mts` scenario showing
ON changes the chosen assignment as expected (`formulation.ts` is pure and
Node-solvable via `highs-adapter`). Manual check still worth doing: open the
**Solver** tab in the browser, toggle a term, and confirm **Generate** reflects
it end-to-end through the worker.

---

## Gotchas for whoever resumes

- Source nvm first (see above) or `npm`/`node` won't be found.
- Keep `npm run check` at 0/0 before committing.
- `xlsx` (npm) has a known advisory and is pinned at 0.18.5 — fine for now;
  could swap to SheetJS's CDN build later.
- The build warns about a >500 kB chunk — that's the HiGHS WASM/glue; acceptable
  (could lazy-load the solver later).
- **HiGHS presolve bug (1.14.2):** presolve mis-pins *continuous* auxiliary
  variables that appear in one constraint + the objective (column singletons),
  returning a sub-optimal solution reported as `Optimal`. Bites Maximize AND
  Minimize; `presolve_rule_off` doesn't help; 1.14.2 is the latest highs-js.
  Refined rule (2026-06-11): the bug's exact shape is a *continuous column
  singleton in the objective* — one constraint + an objective coefficient.
  Continuous aux vars in ≥2 rows, or absent from the objective, are safe (h
  day-subtotals, fairness dev/total, multi-entry daily peaks are continuous).
  The old blanket "every aux var integer" rule is actively harmful at scale:
  ~510 integer h vars handed the brancher bogus candidates and stalled every
  30d incumbent (obj −150000, nothing assigned) until they went continuous.
  Keep integer: aux vars that genuinely can be objective singletons (workload
  `over`, required `short`, single-entry day peaks). Regression repro:
  `npx tsx scripts/presolve-bug.mts`; rule documented on `addContinuous`.
- **consecutiveSameType blows up:** its pairwise z-var formulation ("pairs
  within 1.5× the type's smallest frequency") is ~quadratic and pathological for
  weekly strictTime templates whose day-candidates are all within one window
  (ARCHELON example, 30 days: ~96k aux vars/constraints; times out even with
  presolve). Everything else solves fast (30d/420 instances optimal in ~4.5s).
  Needs reformulation (e.g. only adjacent calendar days, or per-person-per-day
  aggregation) — until then the built-in ARCHELON example ships with it off.
  Size diagnostics: `npx tsx scripts/example-archelon.mts` (build-only) and
  `scripts/example-archelon-solve.mts` (time-capped solves).
- Design notes in [docs/notes/](docs/notes/): `ledger-generate-loop.md` (the
  Generate/regenerate model — supersedes plan.md's materialize text) and
  `dev-environment.md` (Node-via-nvm + working preferences).
```
