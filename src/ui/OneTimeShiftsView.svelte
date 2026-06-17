<script lang="ts">
  import { appData } from "../model/store";
  import {
    addShift,
    updateShift,
    removeShift,
    addRequirement,
    updateRequirement,
    removeRequirement,
    setSlotCount,
  } from "../model/ledger";

  let newName = $state("");

  function add() {
    const name = newName.trim();
    if (!name) return;
    const now = new Date();
    const start = `${toInput(now.toISOString())}:00`;
    addShift({ name, start, durationMinutes: 120 });
    newName = "";
  }

  // datetime-local <-> our seconds-precision ISO string.
  const toInput = (iso: string) => iso.slice(0, 16);
  const fromInput = (v: string) => (v.length === 16 ? `${v}:00` : v);
  const attrName = (id: string) => $appData.attributes.find((a) => a.id === id)?.name ?? "?";

  const oneOffs = $derived($appData.shifts.filter((s) => s.sourceTemplateId === undefined));

  // --- concrete one-off requirement editing (slot-based) -------------------
  function addShiftReqAttr(shiftId: string, i: number, attributeId: string) {
    if (!attributeId) return;
    const r = $appData.shifts.find((s) => s.id === shiftId)?.requirements[i];
    if (r && !r.attributeIds.includes(attributeId)) updateRequirement(shiftId, i, { attributeIds: [...r.attributeIds, attributeId] });
  }
  function removeShiftReqAttr(shiftId: string, i: number, attributeId: string) {
    const r = $appData.shifts.find((s) => s.id === shiftId)?.requirements[i];
    if (r) updateRequirement(shiftId, i, { attributeIds: r.attributeIds.filter((a) => a !== attributeId) });
  }
</script>

<div class="view">
  <h2>One-time shifts</h2>
  <p class="hint">
    One-time shifts are concrete shifts that happen once. Add <em>roles</em> ("need N people
    who are X and Y") to define staffing — give each a name (optional) to label it on the grid;
    no attributes means anyone qualifies, and <em>required</em> roles are flagged when they can't
    be filled. <em>Importance</em> weights how much filling this shift matters. A <em>break</em>
    reserves rest afterwards (soft — see the Solver tab). Assign people in the Rota.
  </p>

  <div class="row" style="margin-bottom: 20px;">
    <input placeholder="New one-time shift name…" bind:value={newName} onkeydown={(e) => e.key === "Enter" && add()} />
    <button class="btn" onclick={add}>Add one-time shift</button>
  </div>

  {#if oneOffs.length === 0}
    <p class="empty">No one-time shifts yet.</p>
  {/if}

  {#each oneOffs as shift (shift.id)}
    <div class="card">
      <div class="card-head">
        <input class="grow" value={shift.name} onchange={(e) => updateShift(shift.id, { name: e.currentTarget.value.trim() })} style="font-size: 16px; font-weight: 600;" />
        <select value={shift.typeId} onchange={(e) => updateShift(shift.id, { typeId: e.currentTarget.value })} style="width: 140px;" title="Shift type">
          {#each $appData.shiftTypes as st (st.id)}
            <option value={st.id}>{st.name}</option>
          {/each}
        </select>
        <button class="btn danger icon" onclick={() => confirm(`Delete shift "${shift.name}"?`) && removeShift(shift.id)}>Delete</button>
      </div>

      <div class="row" style="gap: 16px; margin-bottom: 12px; flex-wrap: wrap;">
        <div class="field">
          <span class="cap">Start</span>
          <input type="datetime-local" value={toInput(shift.start)} onchange={(e) => updateShift(shift.id, { start: fromInput(e.currentTarget.value) })} />
        </div>
        <div class="field">
          <span class="cap">Duration (minutes)</span>
          <input type="number" min="1" value={shift.durationMinutes} onchange={(e) => updateShift(shift.id, { durationMinutes: Number(e.currentTarget.value) })} />
        </div>
        <div class="field">
          <span class="cap">Break after (minutes)</span>
          <input type="number" min="0" value={shift.breakMinutes} onchange={(e) => updateShift(shift.id, { breakMinutes: Math.max(0, Number(e.currentTarget.value)) })} />
        </div>
        <div class="field">
          <span class="cap">Importance</span>
          <input type="number" min="0" step="0.5" value={shift.importance} onchange={(e) => updateShift(shift.id, { importance: Math.max(0, Number(e.currentTarget.value)) })} />
        </div>
      </div>

      <div class="field">
        <span class="cap">Staffing — roles (assign people in the Rota)</span>
        {#each shift.requirements as r, i (i)}
          {@const remaining = $appData.attributes.filter((a) => !r.attributeIds.includes(a.id))}
          <div class="row" style="margin-bottom: 4px; flex-wrap: wrap;">
            <input style="width: 150px;" placeholder="Role name (optional)" value={r.label ?? ""} onchange={(e) => updateRequirement(shift.id, i, { label: e.currentTarget.value.trim() || undefined })} />
            <span class="muted" style="font-size: 13px;">need</span>
            <input type="number" min="1" style="width: 64px;" value={r.slots.length} onchange={(e) => setSlotCount(shift.id, i, Number(e.currentTarget.value))} />
            {#if r.attributeIds.length === 0}
              <span class="muted" style="font-size: 13px;">people (anyone)</span>
            {:else}
              <span class="muted" style="font-size: 13px;">people with</span>
              {#each r.attributeIds as aid (aid)}
                <span class="tag">{attrName(aid)}<button title="Remove attribute" onclick={() => removeShiftReqAttr(shift.id, i, aid)}>×</button></span>
              {/each}
            {/if}
            {#if remaining.length > 0}
              <select value="" onchange={(e) => { addShiftReqAttr(shift.id, i, e.currentTarget.value); e.currentTarget.value = ""; }}>
                <option value="" disabled>+ attribute…</option>
                {#each remaining as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
              </select>
            {/if}
            <label class="row" style="gap: 4px; font-size: 13px;">
              <input type="checkbox" checked={r.required} onchange={(e) => updateRequirement(shift.id, i, { required: e.currentTarget.checked })} /> required
            </label>
            <button class="btn danger icon" onclick={() => removeRequirement(shift.id, i)}>×</button>
          </div>
        {/each}
        <div><button class="btn ghost icon" onclick={() => addRequirement(shift.id)}>+ role</button></div>
      </div>
    </div>
  {/each}
</div>
