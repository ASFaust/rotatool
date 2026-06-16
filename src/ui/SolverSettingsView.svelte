<script lang="ts">
  import { appData } from "../model/store";
  import { mutate } from "../model/mutations";
  import { solverRun } from "../solver/solverLog";

  const run = $derived($solverRun);
  const solving = $derived(run.running);
  const runSeconds = $derived(
    run.running
      ? run.elapsedSec
      : run.startedAt && run.finishedAt
        ? Math.round((run.finishedAt - run.startedAt) / 1000)
        : 0,
  );

  // Keep the log pinned to the newest line as it streams in.
  let logEl = $state<HTMLPreElement>();
  $effect(() => {
    run.lines.length; // track
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  // The objective is a weighted sum: coverage rewards each filled slot (scaled by
  // the shift's importance), breaks subtracts a soft penalty for cutting rest
  // short. Hard constraints (eligibility, availability, no time overlap) are not
  // tunable weights — they always hold.
  const s = $derived($appData.solverSettings);

  function patchTerm(
    key: "coverage" | "breaks" | "peakWindow" | "fairness",
    patch: { enabled?: boolean; weight?: number; windowHours?: number; mode?: "spread" | "deviation"; perShiftType?: boolean },
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

  <section class="block lockable" inert={solving}>
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
    <h3>Solver log</h3>
    <p class="sub">Live HiGHS output from the last “Assign people” run. The progress rows show the optimality gap shrinking toward the 1% target — when it gets there (or the time limit hits), the solver stops.</p>
    <div class="log-status">
      {#if run.running}
        <span class="dot running"></span><span>Running — {runSeconds}s elapsed</span>
      {:else if run.status}
        <span class="dot done"></span><span>{run.status}{runSeconds ? ` — ${runSeconds}s` : ""}</span>
      {:else}
        <span class="dot idle"></span><span>Idle — run “Assign people” on the Ledger tab.</span>
      {/if}
      {#if run.gap !== null}<span class="gap">gap {(run.gap * 100).toFixed(1)}%</span>{/if}
    </div>
    {#if run.lines.length > 0}
      <pre class="log" bind:this={logEl}>{run.lines.join("\n")}</pre>
    {/if}
  </section>

  <section class="block lockable" inert={solving}>
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
            <label class="subcheck">
              <input type="checkbox" checked={s.fairness.perShiftType} onchange={(e) => patchTerm("fairness", { perShiftType: e.currentTarget.checked })} />
              per shift type
            </label>
            <select value={s.fairness.mode} onchange={(e) => patchTerm("fairness", { mode: e.currentTarget.value as "spread" | "deviation" })}>
              <option value="deviation">Balance everyone</option>
              <option value="spread">Squeeze the extremes</option>
            </select>
          </span>
          <input class="weight" type="number" step="0.1" value={s.fairness.weight} onchange={(e) => patchTerm("fairness", { weight: Number(e.currentTarget.value) })} />
        {/if}
      </div>
      <p class="sub">Even out each person's <em>contribution rate over the time they've been around</em>: measure their hours — already worked (Person Hours seed + tracked ledger) plus newly assigned — per week they've been present, scaled by their workload target as a <em>relative</em> weight, and level those rates out. So someone here twice as long is expected to have done about twice the work, and a half-weight part-timer about half — only the ratio between targets matters, not the exact hours (a blank target counts as a full share). <em>Balance everyone</em> pulls the whole roster toward a shared rate; <em>Squeeze the extremes</em> only narrows the gap between the busiest and idlest. <em>Per shift type</em> balances each shift type on its own, so the mix of work is fair too — not just the totals.</p>
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
  .subcheck { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .subcheck input { width: auto; }
  .cap + .weight { margin-left: 12px; }
  .weight { width: 6em; margin-left: auto; }
  input[type="number"] { width: 6em; }
  .log-status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-h); margin: 8px 0; }
  .log-status .gap { margin-left: auto; color: var(--accent); font-variant-numeric: tabular-nums; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .dot.running { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .dot.done { background: #2e9e5b; }
  .dot.idle { background: var(--border); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .lockable[inert] { opacity: 0.5; }
  .log {
    margin: 0; max-height: 320px; overflow: auto; background: var(--code-bg);
    border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
    font-size: 12px; line-height: 1.45; color: var(--text); white-space: pre;
    font-variant-numeric: tabular-nums;
  }
</style>
