<script lang="ts">
  import { appData } from "../model/store";
  import { mutate } from "../model/mutations";

  // The objective is a weighted sum: coverage rewards filled seats, the other
  // terms add penalties (or, for preferences, signed bonuses). Each term is
  // independently toggleable; weights tune their relative pull. Coverage should
  // usually stay dominant so the roster fills before secondary goals are tuned.

  const s = $derived($appData.solverSettings);

  /** Patch a single on/off + weight term. */
  function patchTerm(
    key: "coverage" | "fairness" | "dailyPeak" | "breaks" | "shiftPreferences" | "personPreferences",
    patch: { enabled?: boolean; weight?: number },
  ) {
    mutate((d) => Object.assign(d.solverSettings[key], patch));
  }

  function setFairnessInterval(days: number) {
    mutate((d) => (d.solverSettings.fairness.intervalDays = Math.max(0, Math.round(days))));
  }

  function patchWorkload(patch: { mode?: "off" | "cap" | "balance"; weight?: number }) {
    mutate((d) => Object.assign(d.solverSettings.workload, patch));
  }

  function setProximityGap(minutes: number) {
    mutate((d) => (d.solverSettings.proximityGapMinutes = Math.max(0, minutes)));
  }

  function setTimeLimit(seconds: number) {
    mutate((d) => (d.solverSettings.solveTimeLimitSeconds = Math.max(1, seconds)));
  }

  // Term rows rendered generically, in objective order.
  const terms = [
    { key: "coverage", label: "Coverage", desc: "Reward filling each requirement seat, up to its needed count. The primary goal — keep it on and dominant." },
    { key: "fairness", label: "Fairness (spread)", desc: "Balance hours evenly across people: penalize each person's deviation from their fair share of the hours assigned in each interval (default: every 7 days; 0 = the whole range at once). Shares scale with days available, and with the hours target (People → hours) where set, so e.g. leaders can carry a larger share; people without a target count as average. Keep the weight small (≈0.1) so coverage stays dominant." },
    { key: "dailyPeak", label: "Daily peak", desc: "Per day, penalize the highest workload relative to people's daily targets (the \"maximum overtime ratio\"), so shifts don't clump into brutal single days even when totals are fair. Relative to each person's daily rate; people without a target count at the average." },
    { key: "breaks", label: "Breaks after shifts", desc: "Respect each shift's break (set per shift under Shifts → break): penalize giving someone another shift that starts inside their rest period, per hour of break time violated. Soft — a thin roster can still cut a break short when nothing else works. Breaks don't count as worked hours." },
    { key: "shiftPreferences", label: "Shift preferences", desc: "Apply the signed bonuses/penalties from the Shift Preferences tab for preferred/avoided types and dates." },
    { key: "personPreferences", label: "Person preferences", desc: "Apply signed co-assignment bonuses/penalties from the Person Preferences tab (positive = encourage together, negative = keep apart)." },
  ] as const;
</script>

<div class="view">
  <h2>Solver settings</h2>
  <p class="hint">
    Configure what "Generate" optimizes for. Different organizations want different things,
    so the objective is a weighted sum of toggleable terms. Penalties subtract from coverage —
    raise a weight to make that goal pull harder.
  </p>

  <section class="block">
    <h3>Solver</h3>
    <label class="row">
      <span class="rlabel">Solve time limit</span>
      <span class="rfield">
        <input
          type="number"
          min="1"
          step="5"
          value={s.solveTimeLimitSeconds}
          onchange={(e) => setTimeLimit(Number(e.currentTarget.value))}
        />
        <span class="unit">seconds</span>
      </span>
    </label>
    <p class="sub">
      Generation stops here and keeps the best roster found so far. Balance-type objectives
      (fairness, workload) keep improving in tiny steps long after the roster is good — raise this
      for larger ranges if the result looks unbalanced.
    </p>
  </section>

  <section class="block">
    <h3>Hard constraints</h3>
    <label class="row">
      <span class="rlabel">Minimum gap between a person's shifts</span>
      <span class="rfield">
        <input
          type="number"
          min="0"
          step="15"
          value={s.proximityGapMinutes}
          onchange={(e) => setProximityGap(Number(e.currentTarget.value))}
        />
        <span class="unit">minutes</span>
      </span>
    </label>
    <p class="sub">No one is assigned two shifts that overlap or fall within this gap. 0 still forbids overlaps.</p>
  </section>

  <section class="block">
    <h3>Objective terms</h3>

    <!-- Workload is special: a tri-state mode rather than a simple toggle. -->
    <div class="term">
      <div class="term-head">
        <span class="tname">Workload</span>
        <select value={s.workload.mode} onchange={(e) => patchWorkload({ mode: e.currentTarget.value as "off" | "cap" | "balance" })}>
          <option value="off">Off</option>
          <option value="cap">Hard cap</option>
          <option value="balance">Balance (soft)</option>
        </select>
        {#if s.workload.mode === "balance"}
          <input
            class="weight"
            type="number"
            step="0.1"
            value={s.workload.weight}
            onchange={(e) => patchWorkload({ weight: Number(e.currentTarget.value) })}
          />
        {/if}
      </div>
      <p class="sub">
        Counts each person's hours against their target (set per person under People → hours),
        including Ledger history. <strong>Hard cap</strong> forbids exceeding it;
        <strong>Balance</strong> penalizes hours above target so load spreads out. People with no
        target are unconstrained. For spreading load evenly <em>without</em> absolute targets,
        use Fairness below — the two are independent and can be combined.
      </p>
    </div>

    {#each terms as t}
      <div class="term">
        <div class="term-head">
          <label class="tcheck">
            <input
              type="checkbox"
              checked={s[t.key].enabled}
              onchange={(e) => patchTerm(t.key, { enabled: e.currentTarget.checked })}
            />
            <span class="tname">{t.label}</span>
          </label>
          {#if s[t.key].enabled}
            {#if t.key === "fairness"}
              <span class="unit" style="margin-left: auto;">every</span>
              <input
                style="width: 4em;"
                type="number"
                min="0"
                step="1"
                value={s.fairness.intervalDays}
                onchange={(e) => setFairnessInterval(Number(e.currentTarget.value))}
              />
              <span class="unit">days, weight</span>
              <input
                class="weight"
                style="margin-left: 0;"
                type="number"
                step="0.1"
                value={s[t.key].weight}
                onchange={(e) => patchTerm(t.key, { weight: Number(e.currentTarget.value) })}
              />
            {:else}
              <input
                class="weight"
                type="number"
                step="0.1"
                value={s[t.key].weight}
                onchange={(e) => patchTerm(t.key, { weight: Number(e.currentTarget.value) })}
              />
            {/if}
          {/if}
        </div>
        <p class="sub">{t.desc}</p>
      </div>
    {/each}
  </section>
</div>

<style>
  .block {
    margin-top: 20px;
  }
  .block h3 {
    margin: 0 0 8px;
    font-size: 15px;
    color: var(--text-h);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .rlabel {
    font-size: 15px;
  }
  .rfield {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .unit,
  .sub {
    color: var(--text);
    font-size: 13px;
  }
  .sub {
    margin: 4px 0 0;
  }
  .term {
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  .term-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .tcheck {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .tname {
    font-size: 15px;
    color: var(--text-h);
    font-weight: 600;
  }
  .weight {
    width: 6em;
    margin-left: auto;
  }
  .term-head select {
    margin-left: auto;
  }
  .term-head select + .weight {
    margin-left: 8px;
  }
  input[type="number"] {
    width: 6em;
  }
</style>
