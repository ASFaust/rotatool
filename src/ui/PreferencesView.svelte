<script lang="ts">
  import { appData } from "../model/store";
  import { mutate } from "../model/mutations";

  // Distinct shift types defined across templates, for the datalist.
  const shiftTypes = $derived(
    [...new Set($appData.shiftTemplates.map((s) => s.type).filter((t) => t.trim() !== ""))],
  );

  function addPref() {
    const first = $appData.persons[0];
    if (!first) return;
    mutate((d) => d.preferences.push({ personId: first.id, shiftType: "", weight: 1 }));
  }
  function update(index: number, patch: Record<string, unknown>) {
    mutate((d) => Object.assign(d.preferences[index], patch));
  }
  function remove(index: number) {
    mutate((d) => d.preferences.splice(index, 1));
  }
</script>

<div class="view">
  <h2>Preferences</h2>
  <p class="hint">
    Soft bonuses or penalties for a person's preferred or avoided shift types and date ranges.
    Positive weight = preferred, negative = avoided. Leave a field blank to make it apply
    broadly (any type, or any date).
  </p>

  {#if $appData.persons.length === 0}
    <p class="empty">Add people first.</p>
  {:else}
    <datalist id="shift-types">
      {#each shiftTypes as t}<option value={t}></option>{/each}
    </datalist>
    <table class="data">
      <thead>
        <tr><th>Person</th><th>Shift type</th><th>From</th><th>To</th><th>Weight</th><th></th></tr>
      </thead>
      <tbody>
        {#each $appData.preferences as pref, i (i)}
          <tr>
            <td>
              <select value={pref.personId} onchange={(e) => update(i, { personId: e.currentTarget.value })}>
                {#each $appData.persons as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
              </select>
            </td>
            <td>
              <input
                list="shift-types"
                placeholder="(any)"
                value={pref.shiftType}
                onchange={(e) => update(i, { shiftType: e.currentTarget.value.trim() })}
              />
            </td>
            <td>
              <input type="date" value={pref.dateRangeStart ?? ""} onchange={(e) => update(i, { dateRangeStart: e.currentTarget.value || undefined })} />
            </td>
            <td>
              <input type="date" value={pref.dateRangeEnd ?? ""} onchange={(e) => update(i, { dateRangeEnd: e.currentTarget.value || undefined })} />
            </td>
            <td>
              <input type="number" value={pref.weight} onchange={(e) => update(i, { weight: Number(e.currentTarget.value) })} />
            </td>
            <td style="text-align:right;">
              <button class="btn danger icon" onclick={() => remove(i)}>×</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div style="margin-top: 12px;"><button class="btn" onclick={addPref}>Add preference</button></div>
  {/if}
</div>
