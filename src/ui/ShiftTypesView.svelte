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
    if (used > 0) {
      const ok = confirm(
        `Shift type "${name}" is in use by ${used} shift(s)/template(s). ` +
          `They will be moved to the default type. Continue?`,
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
        <th style="width: 60%;">Name</th>
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
