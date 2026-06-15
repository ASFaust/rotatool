<script lang="ts">
  import { appData } from "../model/store";
  import { mutate } from "../model/mutations";

  // The objective is a weighted sum: coverage rewards each filled slot (scaled by
  // the shift's importance), breaks subtracts a soft penalty for cutting rest
  // short. Hard constraints (eligibility, availability, no time overlap) are not
  // tunable weights — they always hold.
  const s = $derived($appData.solverSettings);

  function patchTerm(
    key: "coverage" | "breaks" | "peakWindow" | "fairness",
    patch: { enabled?: boolean; weight?: number; windowHours?: number; mode?: "spread" | "deviation" },
  ) {
    mutate((d) => Object.assign(d.solverSettings[key], patch));
  }
  function setTimeLimit(seconds: number) {
    mutate((d) => (d.solverSettings.solveTimeLimitSeconds = Math.max(1, seconds)));
  }

  const terms = [
    { key: "coverage", label: "Coverage", desc: "Reward filling each requirement slot, scaled by the shift's importance. The primary goal — keep it on. Required slots fill first regardless of weight." },
    { key: "breaks", label: "Breaks after shifts", desc: "Respect each shift's break (set per shift under Shifts → break): penalize giving someone another shift that starts inside their rest period, per hour of break time violated. Soft — a thin roster can still cut a break short." },
  ] as const;
</script>

<div class="view">
  <h2>Solver settings</h2>
  <p class="hint">
    Configure what "Assign people" optimizes for. The objective is a weighted sum of toggleable
    terms; coverage fills slots, breaks subtracts a soft penalty.
  </p>

  <section class="block">
    <h3>Solver</h3>
    <label class="row">
      <span class="rlabel">Solve time limit</span>
      <span class="rfield">
        <input type="number" min="1" step="5" value={s.solveTimeLimitSeconds} onchange={(e) => setTimeLimit(Number(e.currentTarget.value))} />
        <span class="unit">seconds</span>
      </span>
    </label>
    <p class="sub">Assignment stops here and keeps the best roster found so far.</p>
  </section>

  <section class="block">
    <h3>Objective terms</h3>
    {#each terms as t}
      <div class="term">
        <div class="term-head">
          <label class="tcheck">
            <input type="checkbox" checked={s[t.key].enabled} onchange={(e) => patchTerm(t.key, { enabled: e.currentTarget.checked })} />
            <span class="tname">{t.label}</span>
          </label>
          {#if s[t.key].enabled}
            <input class="weight" type="number" step="0.1" value={s[t.key].weight} onchange={(e) => patchTerm(t.key, { weight: Number(e.currentTarget.value) })} />
          {/if}
        </div>
        <p class="sub">{t.desc}</p>
      </div>
    {/each}

    <div class="term">
      <div class="term-head">
        <label class="tcheck">
          <input type="checkbox" checked={s.peakWindow.enabled} onchange={(e) => patchTerm("peakWindow", { enabled: e.currentTarget.checked })} />
          <span class="tname">Flatten the busiest stretch</span>
        </label>
        {#if s.peakWindow.enabled}
          <span class="cap">
            window
            <input type="number" min="1" step="1" value={s.peakWindow.windowHours} onchange={(e) => patchTerm("peakWindow", { windowHours: Math.max(1, Number(e.currentTarget.value)) })} />
            h
          </span>
          <input class="weight" type="number" step="0.1" value={s.peakWindow.weight} onchange={(e) => patchTerm("peakWindow", { weight: Number(e.currentTarget.value) })} />
        {/if}
      </div>
      <p class="sub">Penalize, per hour, the heaviest rolling window of assigned work faced by any one person across the whole range — shrinking the single worst stretch anyone works. A shift counts toward a window if it starts within it; hand-assigned time counts too.</p>
    </div>

    <div class="term">
      <div class="term-head">
        <label class="tcheck">
          <input type="checkbox" checked={s.fairness.enabled} onchange={(e) => patchTerm("fairness", { enabled: e.currentTarget.checked })} />
          <span class="tname">Balance workload fairly</span>
        </label>
        {#if s.fairness.enabled}
          <span class="cap">
            <select value={s.fairness.mode} onchange={(e) => patchTerm("fairness", { mode: e.currentTarget.value as "spread" | "deviation" })}>
              <option value="deviation">Balance everyone</option>
              <option value="spread">Squeeze the extremes</option>
            </select>
          </span>
          <input class="weight" type="number" step="0.1" value={s.fairness.weight} onchange={(e) => patchTerm("fairness", { weight: Number(e.currentTarget.value) })} />
        {/if}
      </div>
      <p class="sub">Even out total workload <em>proportional to each person's weekly target</em>: measure everyone's hours — already worked (Person Hours seed + tracked ledger) plus newly assigned — as a fraction of their weekly target, and level those out. <em>Balance everyone</em> pulls the whole roster toward a shared level; <em>Squeeze the extremes</em> only narrows the gap between the busiest and idlest. People with no workload target set are left out.</p>
    </div>
  </section>
</div>

<style>
  .block { margin-top: 20px; }
  .block h3 { margin: 0 0 8px; font-size: 15px; color: var(--text-h); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .rlabel { font-size: 15px; }
  .rfield { display: flex; align-items: center; gap: 6px; }
  .unit, .sub { color: var(--text); font-size: 13px; }
  .sub { margin: 4px 0 0; }
  .term { padding: 12px 0; border-top: 1px solid var(--border); }
  .term-head { display: flex; align-items: center; gap: 12px; }
  .tcheck { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .tname { font-size: 15px; color: var(--text-h); font-weight: 600; }
  .cap { display: flex; align-items: center; gap: 6px; margin-left: auto; font-size: 13px; color: var(--text); }
  .cap input { width: 4.5em; }
  .cap + .weight { margin-left: 12px; }
  .weight { width: 6em; margin-left: auto; }
  input[type="number"] { width: 6em; }
</style>
