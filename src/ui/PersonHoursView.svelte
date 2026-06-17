<script lang="ts">
  import { appData } from "../model/store";
  import { setPersonHours, setAllPersonHours, updatePrefillSettings } from "../model/mutations";
  import { computeDerivedHours, computePrefillSeed, computeUtilization, personStartDate, weeklyHours } from "../model/hours";

  // personId -> typeId -> hours derived from the tracked ledger.
  const derivedHours = $derived(computeDerivedHours($appData));
  // "personId|typeId" -> manually-entered hours.
  const manual = $derived(
    new Map($appData.personHours.map((h) => [`${h.personId}|${h.typeId}`, h.hours] as const)),
  );

  const round1 = (x: number) => Math.round(x * 10) / 10;

  // Utilization (pace) diagnostic — read-only. Same horizon as the solver's
  // window end: the inclusive `to` day, so it lines up with what fairness sees.
  const horizon = $derived(new Date(new Date(`${$appData.ledgerView.to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000));
  const util = $derived(computeUtilization($appData, horizon));
  // Overall pace U_p = worked ÷ expected hours, as a percent; null when the
  // person has no start date or weekly target (excluded from fairness).
  const paceOf = (personId: string): number | null => {
    const u = util.get(personId);
    return u && u.eligible ? (u.workedTotal / u.denom) * 100 : null;
  };
  // Per-type pace breakdown, for the cell tooltip.
  const paceBreakdown = (personId: string): string => {
    const u = util.get(personId);
    if (!u || !u.eligible) return "No start date or weekly target — excluded from fairness.";
    return $appData.shiftTypes
      .map((st) => `${st.name}: ${Math.round(((u.workedByType.get(st.id) ?? 0) / u.denom) * 100)}%`)
      .join("\n");
  };
  // Cohort pace = Σ worked ÷ Σ expected over eligible people (the fairness center).
  const cohortPace = $derived.by(() => {
    let worked = 0, denom = 0;
    for (const u of util.values()) if (u.eligible) { worked += u.workedTotal; denom += u.denom; }
    return denom > 0 ? (worked / denom) * 100 : null;
  });
  const derivedOf = (personId: string, typeId: string) => derivedHours.get(personId)?.get(typeId) ?? 0;
  const manualOf = (personId: string, typeId: string) => manual.get(`${personId}|${typeId}`) ?? 0;

  function onEdit(personId: string, typeId: string, raw: string) {
    setPersonHours(personId, typeId, Number(raw));
  }

  // Column totals (manual + derived, summed across people) for a quick read.
  const typeTotal = (typeId: string) =>
    $appData.persons.reduce((sum, p) => sum + manualOf(p.id, typeId) + derivedOf(p.id, typeId), 0);
  // Row total (manual + derived across all types) for one person.
  const personTotal = (personId: string) =>
    $appData.shiftTypes.reduce((sum, st) => sum + manualOf(personId, st.id) + derivedOf(personId, st.id), 0);
  const grandTotal = $derived($appData.persons.reduce((sum, p) => sum + personTotal(p.id), 0));

  // --- Seed autofill tool ---------------------------------------------------
  // Pro-rates each person's weekly target from their start date through `endDate`
  // and splits it across shift types by `weights`, overwriting all seed cells.
  // Settings live in the persisted workbook (appData.prefillSettings).
  // The seed is *pre-window history* — hours worked before the planning window
  // begins — so the autofill end date defaults to the day before the Ledger
  // `from` (i.e. credit hours right up to, but not into, the range being planned).
  function dayBefore(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() - 1);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const endDate = $derived($appData.prefillSettings.endDate ?? dayBefore($appData.ledgerView.from));
  const weightOf = (typeId: string) => $appData.prefillSettings.weights[typeId] ?? 1;

  // Active people we can't pro-rate (no availability start or no hours target).
  const skipped = $derived(
    $appData.persons.filter(
      (p) => p.activated && (!personStartDate($appData, p.id) || weeklyHours(p) === null),
    ),
  );

  function setWeight(typeId: string, value: number) {
    updatePrefillSettings({ weights: { ...$appData.prefillSettings.weights, [typeId]: value } });
  }

  function generate() {
    const wmap = new Map($appData.shiftTypes.map((st) => [st.id, weightOf(st.id)] as const));
    setAllPersonHours(computePrefillSeed($appData, endDate, wmap));
  }
</script>

<div class="view">
  <h2>Person Hours</h2>
  <p class="hint">
    Hours each person has already worked, per shift type. The <strong>seed</strong> column is
    editable — use it to record hours worked <em>before</em> you started tracking shifts here
    (e.g. when adopting mid-season). <strong>Ledger</strong> is derived automatically from the
    assigned shifts in this workbook. The <strong>total</strong> (seed + ledger) is what later
    feeds fairness and distribution objectives. <strong>Pace</strong> is each person's utilization —
    total hours ÷ the hours expected over the time they've been available (at their weekly target),
    through the Ledger end date; hover for the per-type split. It's the signal the fairness objective
    balances; “—” means no start date or weekly target, so they're excluded.
  </p>

  {#if $appData.persons.length === 0}
    <p class="empty">No people yet — add some on the People tab.</p>
  {:else}
    <div class="matrix-scroll">
      <table class="data matrix">
        <thead>
          <tr>
            <th class="corner">Person</th>
            {#each $appData.shiftTypes as st (st.id)}
              <th>{st.name}</th>
            {/each}
            <th class="total-col">Total</th>
            <th class="pace-col">Pace</th>
          </tr>
          <tr class="legend">
            <th></th>
            {#each $appData.shiftTypes as st (st.id)}
              <th><span class="seed-l">seed</span> + ledger = total</th>
            {/each}
            <th class="total-col">seed + ledger</th>
            <th class="pace-col">worked ÷ expected</th>
          </tr>
        </thead>
        <tbody>
          {#each $appData.persons as p (p.id)}
            <tr>
              <th class="rowhead">{p.name}</th>
              {#each $appData.shiftTypes as st (st.id)}
                {@const d = derivedOf(p.id, st.id)}
                {@const m = manualOf(p.id, st.id)}
                <td>
                  <div class="cell">
                    <input
                      class="hrs"
                      type="number"
                      min="0"
                      step="0.5"
                      value={m || ""}
                      placeholder="0"
                      onchange={(e) => onEdit(p.id, st.id, e.currentTarget.value)}
                    />
                    <span class="calc">
                      <span class="led" title="Derived from assigned shifts">+{round1(d)}</span>
                      <span class="tot" title="Seed + ledger">= {round1(m + d)}</span>
                    </span>
                  </div>
                </td>
              {/each}
              <td class="total-col coltotal">{round1(personTotal(p.id))}</td>
              <td class="pace-col coltotal" title={paceBreakdown(p.id)}>
                {paceOf(p.id) === null ? "—" : `${Math.round(paceOf(p.id)!)}%`}
              </td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <th class="rowhead">All people</th>
            {#each $appData.shiftTypes as st (st.id)}
              <td class="coltotal">{round1(typeTotal(st.id))}</td>
            {/each}
            <td class="total-col coltotal">{round1(grandTotal)}</td>
            <td class="pace-col coltotal" title="Worked ÷ expected over everyone with a start date and weekly target — the fairness center.">
              {cohortPace === null ? "—" : `${Math.round(cohortPace)}%`}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <section class="prefiller">
      <h3>Seed autofill</h3>
      <p class="hint">
        Fairly prefill the seed columns: each active person is credited the hours they'd have
        worked from their start date (earliest availability) through the end date below, at their
        weekly hours target, split across shift types by the weights. The end date defaults to the
        day before the Ledger range — the seed is the <em>history before</em> the window you're about
        to plan. This <strong>overwrites</strong> all seed values.
      </p>
      <div class="controls">
        <label class="ctl">
          <span>End date</span>
          <input
            type="date"
            value={endDate}
            onchange={(e) => updatePrefillSettings({ endDate: e.currentTarget.value })}
          />
        </label>
        {#each $appData.shiftTypes as st (st.id)}
          <label class="ctl">
            <span>{st.name}</span>
            <input
              class="wt"
              type="number"
              min="0"
              step="0.5"
              value={weightOf(st.id)}
              placeholder="1"
              onchange={(e) => setWeight(st.id, Number(e.currentTarget.value))}
            />
          </label>
        {/each}
        <button class="gen" onclick={generate}>Generate</button>
      </div>
      {#if skipped.length > 0}
        <p class="warn">
          Skipped (no start date or no hours target): {skipped.map((p) => p.name).join(", ")}
        </p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .matrix-scroll { overflow-x: auto; }
  .matrix { min-width: max-content; }
  .matrix th, .matrix td { white-space: nowrap; }
  .matrix tbody td { padding-top: 4px; padding-bottom: 4px; }
  .matrix .corner, .matrix .rowhead {
    text-align: left;
    position: sticky;
    left: 0;
    background: var(--bg);
    z-index: 1;
  }
  .matrix .rowhead { font-weight: 600; color: var(--text-h); }
  .legend th { font-weight: 400; font-size: 11px; color: var(--text); padding-top: 0; }
  .seed-l { color: var(--accent); }
  /* input and the "+derived = total" read-out share one line to keep rows short */
  .cell { display: flex; align-items: center; gap: 8px; }
  .hrs { width: 60px; text-align: right; }
  .calc { font-size: 12px; color: var(--text); white-space: nowrap; }
  .led { color: var(--text); }
  .tot { font-weight: 600; color: var(--text-h); }
  .total-col { border-left: 2px solid var(--border); text-align: right; }
  .pace-col { border-left: 1px solid var(--border); text-align: right; }
  .coltotal { font-weight: 600; color: var(--text-h); font-variant-numeric: tabular-nums; }

  .prefiller {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .prefiller h3 { margin: 0 0 4px; }
  .controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
  .ctl { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--text); }
  .ctl .wt { width: 70px; }
  .gen { align-self: flex-end; }
  .warn { margin-top: 8px; font-size: 12px; color: var(--text); }
</style>
