<script lang="ts">
  import { appData } from "../model/store";
  import { DEFAULT_SHIFT_TYPE_ID } from "../model/schema";
  import { addShiftType, updateShiftType, removeShiftType } from "../model/mutations";

  let newName = $state("");

  function add() {
    const name = newName.trim();
    if (!name) return;
    addShiftType(name);
    newName = "";
  }

  function nameTaken(name: string, exceptId: string): boolean {
    const n = name.trim().toLowerCase();
    return $appData.shiftTypes.some((t) => t.id !== exceptId && t.name.toLowerCase() === n);
  }

  /** How many shifts + templates currently reference a type. */
  function usageOf(typeId: string): number {
    let n = 0;
    for (const t of $appData.shiftTemplates) if (t.typeId === typeId) n++;
    for (const s of $appData.shifts) if (s.typeId === typeId) n++;
    return n;
  }

  function del(id: string, name: string) {
    const used = usageOf(id);
    const seeded = $appData.personHours.filter((h) => h.typeId === id).length;
    if (used > 0 || seeded > 0) {
      const parts: string[] = [];
      if (used > 0) parts.push(`${used} shift(s)/template(s)`);
      if (seeded > 0) parts.push(`${seeded} seeded person-hour row(s)`);
      const ok = confirm(
        `Shift type "${name}" is in use by ${parts.join(" and ")}. ` +
          `Its shifts move to the default type and its seeded hours are added to ` +
          `each person's default-type hours. Continue?`,
      );
      if (!ok) return;
    }
    removeShiftType(id);
  }
</script>

<div class="view">
  <h2>Shift Types</h2>
  <p class="hint">
    Org-defined categories a shift can belong to (e.g. <em>morning survey</em>, <em>kiosk</em>,
    <em>cooking</em>). Every shift has exactly one type; later they drive fairness and
    distribution objectives. The built-in <em>default</em> type can be renamed but not deleted —
    deleting any other type moves its shifts back to the default.
  </p>

  <div class="row" style="margin-bottom: 16px;">
    <input
      placeholder="New shift type name…"
      bind:value={newName}
      onkeydown={(e) => e.key === "Enter" && add()}
    />
    <button class="btn" onclick={add}>Add shift type</button>
  </div>

  <table class="data">
    <thead>
      <tr>
        <th style="width: 55%;">Name</th>
        <th>Color</th>
        <th>In use</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each $appData.shiftTypes as st (st.id)}
        {@const isDefault = st.id === DEFAULT_SHIFT_TYPE_ID}
        <tr>
          <td>
            <input
              value={st.name}
              onchange={(e) => updateShiftType(st.id, { name: e.currentTarget.value.trim() })}
              style="width: 100%;"
            />
            {#if nameTaken(st.name, st.id)}
              <span class="muted" style="color:#c0392b; font-size:12px;">duplicate name</span>
            {:else if isDefault}
              <span class="muted" style="font-size:12px;">default type</span>
            {/if}
          </td>
          <td>
            <input
              type="color"
              value={st.color}
              onchange={(e) => updateShiftType(st.id, { color: e.currentTarget.value })}
              title="Color used in the rota grid"
              style="width: 40px; height: 28px; padding: 0; cursor: pointer;"
            />
          </td>
          <td>{usageOf(st.id)}</td>
          <td style="text-align:right;">
            {#if !isDefault}
              <button class="btn danger icon" onclick={() => del(st.id, st.name)}>Delete</button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
