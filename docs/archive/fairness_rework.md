> **⚠ Archived 2026-06-17 — implemented, no longer pending work.**
> This was a planning doc; the rework shipped 2026-06-17. The "Resolution (as
> built)" section at the bottom is the accurate record of the current fairness
> implementation — read that, ignore the forward-looking "open decisions" above
> it. Further fairness polish is tracked in [ROADMAP.md](../../ROADMAP.md) (item 6).

# Fairness objective rework — history-aware targets

Status: **implemented 2026-06-17.** The design below stands; the resolved open
decisions and the as-built shape are recorded in "Resolution" at the bottom.

## Motivation

The current fairness term (`solverSettings.fairness`, built in
`src/solver/formulation.ts`) produces *worse* rosters when enabled. The problem
is **not** the optimization shape — the L1 (`min Σ|·|`) and min-max
(`min max|·|`) shells work well and stay. The problem is **how prior history is
fed in**: today the term couples every person's *ratio* together through shared
aux vars (`M`/`m` for spread, shared `R` + per-person `dev` for deviation) over
an opaque relative-weight × tenure-normalized denominator. That coupling fights
coverage and weakens the LP relaxation.

The fix: keep the L1 / min-max shells, but point them at a **precomputed,
per-person, per-shift-type target number of hours**. All the history reasoning
moves *out* of the LP into a plain pre-pass that produces those targets.

## The comparable signal (history)

For each person `p`, one denominator shared across all shift types:

```
denom_p = effective_available_time(start_p → ledgerView.to) × hours_per_interval_p
U_{p,t} = worked_{p,t} / denom_p
```

- `U_{p,t}` is utilization — dimensionless, **comparable across people**
  regardless of tenure or part-time status.
- `denom_p` is **not** per-type, so the per-type `U_{p,t}` sum to a person's
  total `U_p`. Total and per-type fairness fall out of the same formula.
- `worked_{p,t}` = seed (`personHours`) + ledger-derived
  (`computeDerivedHours`) for that type, measured through `ledgerView.to`.

### New rule

**Every person must have a start date and a desired hours-per-interval.** This
removes the old fallbacks ("blank target = full share", "no start → window
start"). Anyone missing either is **excluded from the fairness term and listed
in a warning** (same UX as the current `skipped` set on the Person Hours tab).

## Target computation (the pre-pass)

Common point per type `T_t` = **mean or median** of `U_{·,t}` across the
eligible people (selectable — same spirit as today's `mode: spread | deviation`
toggle).

```
Δ_{p,t}      = clamp( (T_t − U_{p,t}) · denom_p,  −maxLess, +maxMore )
target_{p,t} = worked_{p,t} + Δ_{p,t}
```

- Above-average people get a negative Δ (assign them less); below-average get a
  positive Δ (catch up). Both are **ramp-capped** — this is the clean knob.
- The cap prevents dumping a whole season's backlog onto a laggard in one
  window.

The LP then reuses the existing shells over deviation from target:

```
L1:       min Σ_p |assigned_{p,t} − (target adjustment)|
min-max:  min max_p |assigned_{p,t} − (target adjustment)|
```

## Subtleties that MUST be handled (the actual hard part)

These are why this is a real refactor and not a one-liner. All of them concern
correctly translating a *target over a timeframe* into a *target for the solver
to assign*.

1. **"Target hours for the solver to assign" ≠ "target hours for a person within
   the timeframe."** Some shifts in the optimizer interval may **already be
   assigned** (fixed slots holding a `personId`). Those count toward the person's
   worked hours but are **not** decision variables. The solver's per-person
   target must subtract already-assigned in-window hours, or it will double-count
   and chase the wrong number. The decision-variable target is:
   `solver_target_{p,t} = desired_total_{p,t} − already_assigned_in_window_{p,t}`
   (floored at 0).

2. **Availability-aware denominator, not raw calendar.**
   `(ledgerView.to − start_p)` overcounts anyone who took leave — they'd look
   like slackers. Use effective available time (union of `available` minus
   `unavailable`), which `availableWeeks()` in `src/model/hours.ts:102` already
   computes. "Days working till ledgerView.to" = effective available span.

3. **In-window availability caps the reachable target.** If `p` is only present
   for part of the window, their `Δ_{p,t}` cannot exceed the hours they can
   physically be assigned in the window. The clamp's upper bound is
   `min(maxMore, assignable-hours-in-window_p)`. Otherwise the term chases an
   unreachable target and just adds noise.

4. **Pool conservation / center calibration.** Coverage already forces
   `Σ_p assigned_{·,t} ≈ pool_t` (the seats that exist in type t this window).
   But `Σ_p Δ_{p,t}` only equals `pool_t` if `T_t` is the *post-distribution*
   equal utilization `(Σ worked + pool_t) / Σ denom`, **not** the *current*
   mean/median. If targets don't sum to the pool, every person carries a constant
   residual and the L1/min-max balances around a slightly-wrong center.
   - Mean/median → right *direction*.
   - Post-distribution equal utilization → right *center* (and exactly
     distributes the pool).
   - May be moot if the ramp clamps dominate — needs a decision/experiment.

## Person Hours tab → diagnostic

Independently of the optimizer, the Person Hours tab
(`src/ui/PersonHoursView.svelte`) should surface `U_{p,t}` and `U_p` as a
read-only diagnostic: who is under/over their pace, overall and per shift type,
using `ledgerView.to` as the common horizon. Keep the seed input + autofill
(still useful to bootstrap `worked_{p,t}` for mid-season adoption).

## Files in scope

- `src/solver/formulation.ts` — replace the `fairness` block (~L322–470) with the
  new target-deviation term; the target pre-pass can live here or in `hours.ts`.
- `src/model/hours.ts` — add a `computeUtilization` helper (per-person +
  per-type `U`) shared by the tab and the solver; reuse `availableWeeks`,
  `weeklyHours`, `personStartDate`, `computeDerivedHours`.
- `src/model/schema.ts:269` — replace the `fairness` term shape
  (`mode`/`perShiftType`) with the new knobs (`mode: L1 | min-max`, ramp caps
  `maxMore`/`maxLess`, mean-vs-median center, per-type toggle); add a migration.
- `src/ui/SolverSettingsView.svelte:117` — swap fairness controls for the new
  knobs.
- `src/ui/PersonHoursView.svelte` — add the `U` diagnostic columns.

## Open decisions for tomorrow

- Center: current mean/median vs post-distribution equal utilization (subtlety 4).
- Mean vs median default.
- One symmetric ramp cap or separate `maxMore` / `maxLess`.
- Whether per-shift-type balancing is in scope for the first cut or total-only
  first (per-type diagnostic regardless).
- Exact handling of already-assigned in-window hours (subtlety 1) in the
  deviation expression.

## Resolution (as built, 2026-06-17)

Knobs: `mode: "L1" | "min-max"`, `perShiftType`, `maxCatchUpHours` (the ramp
cap), plus `enabled`/`weight`. Migration v7→v8 maps `deviation→L1`, `spread→min-max`,
backfills `maxCatchUpHours: 40`.

- **Subtlety 1:** no explicit subtraction. `worked_p` is measured through
  `rangeEnd` (`computeUtilization` → `computeDerivedHours(data, rangeEnd)`), which
  already includes filled in-window slots; decision vars cover only *empty* seats,
  so the new-hours target is just `Δ_p = T·denom_p − worked_p` with no double-count.
- **Subtlety 2:** `denom_p = availableWeeks(start_p → rangeEnd) × weeklyHours_p`.
- **Subtlety 3:** `target_p = clamp(Δ_p, 0, min(maxCatchUpHours, assignable_p))`,
  `assignable_p` = Σ candidate-seat hours in scope (from `seatVarsByPerson`).
- **Subtlety 4:** chose **post-distribution equal utilization** as the center,
  `T = (Σ_elig worked + pool) / Σ_elig denom`; `pool` = open in-scope seat-hours.
  Dropped the mean/median toggle. (`pool` slightly overcounts when ineligible
  people also take seats — accepted; clamps bound it.)
- **`maxLess` dropped:** in an add-only solver you can never push an over-utilized
  person below current hours; the floor-at-0 on new-assigned does that. So only the
  catch-up cap (`maxMore`) is meaningful — one knob, not two.
- **Decoupling (the LP fix):** targets are absolute per-person constants, so L1
  needs no shared `R` and min-max no shared `M`/`m`; each person's aux var is
  independent. Deviation is in **hours**, so `weight` = penalty per hour off target.

Per-type balancing **is** in the first cut (`perShiftType`). The Person Hours tab
gained a read-only **Pace** column (`U_p`, per-type in the tooltip) plus a cohort
pace footer; `SolverSettingsView` lists fairness-excluded active people.
