<script lang="ts">
  import { appData } from "../model/store";
  import { setPersonHours } from "../model/mutations";
  import { computeDerivedHours } from "../model/hours";

  // personId -> typeId -> hours derived from the tracked ledger.
  const derivedHours = $derived(computeDerivedHours($appData));
  // "personId|typeId" -> manually-entered hours.
  const manual = $derived(
    new Map($appData.personHours.map((h) => [`${h.personId}|${h.typeId}`, h.hours] as const)),
  );

  const round1 = (x: number) => Math.round(x * 10) / 10;
  const derivedOf = (personId: string, typeId: string) => derivedHours.get(personId)?.get(typeId) ?? 0;
  const manualOf = (personId: string, typeId: string) => manual.get(`${personId}|${typeId}`) ?? 0;

  function onEdit(personId: string, typeId: string, raw: string) {
    setPersonHours(personId, typeId, Number(raw));
  }

  // Column totals (manual + derived, summed across people) for a quick read.
  const typeTotal = (typeId: string) =>
    $appData.persons.reduce((sum, p) => sum + manualOf(p.id, typeId) + derivedOf(p.id, typeId), 0);
</script>

<div class="view">
  <h2>Person Hours</h2>
  <p class="hint">
    Hours each person has already worked, per shift type. The <strong>seed</strong> column is
    editable — use it to record hours worked <em>before</em> you started tracking shifts here
    (e.g. when adopting mid-season). <strong>Ledger</strong> is derived automatically from the
    assigned shifts in this workbook. The <strong>total</strong> (seed + ledger) is what later
    feeds fairness and distribution objectives.
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
          </tr>
          <tr class="legend">
            <th></th>
            {#each $appData.shiftTypes as st (st.id)}
              <th><span class="seed-l">seed</span> + <span class="led-l">ledger</span> = total</th>
            {/each}
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
                  <input
                    class="hrs"
                    type="number"
                    min="0"
                    step="0.5"
                    value={m || ""}
                    placeholder="0"
                    onchange={(e) => onEdit(p.id, st.id, e.currentTarget.value)}
                  />
                  <div class="sub">
                    <span class="led" title="Derived from assigned shifts">+{round1(d)}</span>
                    <span class="tot" title="Seed + ledger">= {round1(m + d)}</span>
                  </div>
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <th class="rowhead">All people</th>
            {#each $appData.shiftTypes as st (st.id)}
              <td class="coltotal">{round1(typeTotal(st.id))}</td>
            {/each}
          </tr>
        </tfoot>
      </table>
    </div>
  {/if}
</div>

<style>
  .matrix-scroll { overflow-x: auto; }
  .matrix { min-width: max-content; }
  .matrix th, .matrix td { white-space: nowrap; }
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
  .led-l { color: var(--text); }
  .hrs { width: 64px; text-align: right; }
  .sub { font-size: 11px; color: var(--text); margin-top: 2px; display: flex; gap: 6px; }
  .led { color: var(--text); }
  .tot { font-weight: 600; color: var(--text-h); }
  .coltotal { font-weight: 600; color: var(--text-h); font-variant-numeric: tabular-nums; }
</style>
