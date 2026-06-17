<script lang="ts">
  import { appData } from "../model/store";
  import {
    mutate,
    addShiftTemplate,
    updateShiftTemplate,
    removeShiftTemplate,
  } from "../model/mutations";

  let newName = $state("");

  function add() {
    const name = newName.trim();
    if (!name) return;
    addShiftTemplate(name);
    newName = "";
  }

  // datetime-local <-> our seconds-precision ISO string.
  const toInput = (iso: string) => iso.slice(0, 16);
  const fromInput = (v: string) => (v.length === 16 ? `${v}:00` : v);
  const attrName = (id: string) => $appData.attributes.find((a) => a.id === id)?.name ?? "?";

  // --- template requirement editing (embedded, count-based) ----------------
  function addTemplateReq(templateId: string) {
    mutate((d) => d.shiftTemplates.find((t) => t.id === templateId)?.requirements.push({ attributeIds: [], count: 1, required: false }));
  }
  function patchTemplateReq(templateId: string, i: number, patch: Record<string, unknown>) {
    mutate((d) => {
      const r = d.shiftTemplates.find((t) => t.id === templateId)?.requirements[i];
      if (r) Object.assign(r, patch);
    });
  }
  function removeTemplateReq(templateId: string, i: number) {
    mutate((d) => d.shiftTemplates.find((t) => t.id === templateId)?.requirements.splice(i, 1));
  }
  function addTemplateReqAttr(templateId: string, i: number, attributeId: string) {
    if (!attributeId) return;
    mutate((d) => {
      const r = d.shiftTemplates.find((t) => t.id === templateId)?.requirements[i];
      if (r && !r.attributeIds.includes(attributeId)) r.attributeIds.push(attributeId);
    });
  }
  function removeTemplateReqAttr(templateId: string, i: number, attributeId: string) {
    mutate((d) => {
      const r = d.shiftTemplates.find((t) => t.id === templateId)?.requirements[i];
      if (r) r.attributeIds = r.attributeIds.filter((a) => a !== attributeId);
    });
  }
</script>

<div class="view">
  <h2>Recurring shifts</h2>
  <p class="hint">
    Recurring shifts are templates: they get instanced into concrete dated shifts in the Rota
    over your chosen range. Add <em>people slots</em> ("need N people who are X and Y") to define
    staffing — no attributes means anyone qualifies, and <em>required</em> slots are flagged when
    they can't be filled. <em>Importance</em> weights how much filling this shift matters. A
    <em>break</em> reserves rest after each occurrence (soft — see the Solver tab).
  </p>

  <div class="row" style="margin-bottom: 20px;">
    <input placeholder="New recurring shift name…" bind:value={newName} onkeydown={(e) => e.key === "Enter" && add()} />
    <button class="btn" onclick={add}>Add recurring shift</button>
  </div>

  {#if $appData.shiftTemplates.length === 0}
    <p class="empty">No recurring shifts yet.</p>
  {/if}

  {#each $appData.shiftTemplates as shift (shift.id)}
    <div class="card">
      <div class="card-head">
        <input class="grow" value={shift.name} onchange={(e) => updateShiftTemplate(shift.id, { name: e.currentTarget.value.trim() })} style="font-size: 16px; font-weight: 600;" />
        <select value={shift.typeId} onchange={(e) => updateShiftTemplate(shift.id, { typeId: e.currentTarget.value })} style="width: 140px;" title="Shift type">
          {#each $appData.shiftTypes as st (st.id)}
            <option value={st.id}>{st.name}</option>
          {/each}
        </select>
        <button class="btn danger icon" onclick={() => confirm(`Delete shift "${shift.name}"?`) && removeShiftTemplate(shift.id)}>Delete</button>
      </div>

      <div class="row" style="gap: 16px; margin-bottom: 12px; flex-wrap: wrap;">
        <div class="field">
          <span class="cap">Anchor (first occurrence)</span>
          <input type="datetime-local" value={toInput(shift.activationDateTime)} onchange={(e) => updateShiftTemplate(shift.id, { activationDateTime: fromInput(e.currentTarget.value) })} />
        </div>
        <div class="field">
          <span class="cap">Repeat every</span>
          <div class="row">
            <input type="number" min="1" value={shift.frequency.value} onchange={(e) => updateShiftTemplate(shift.id, { frequency: { ...shift.frequency, value: Number(e.currentTarget.value) } })} />
            <select value={shift.frequency.unit} onchange={(e) => updateShiftTemplate(shift.id, { frequency: { ...shift.frequency, unit: e.currentTarget.value as "days" | "hours" } })}>
              <option value="days">days</option>
              <option value="hours">hours</option>
            </select>
          </div>
        </div>
        <div class="field">
          <span class="cap">Duration (minutes)</span>
          <input type="number" min="1" value={shift.durationMinutes} onchange={(e) => updateShiftTemplate(shift.id, { durationMinutes: Number(e.currentTarget.value) })} />
        </div>
        <div class="field">
          <span class="cap">Break after (minutes)</span>
          <input type="number" min="0" value={shift.breakMinutes} onchange={(e) => updateShiftTemplate(shift.id, { breakMinutes: Math.max(0, Number(e.currentTarget.value)) })} />
        </div>
        <div class="field">
          <span class="cap">Importance</span>
          <input type="number" min="0" step="0.5" value={shift.importance} onchange={(e) => updateShiftTemplate(shift.id, { importance: Math.max(0, Number(e.currentTarget.value)) })} />
        </div>
        <div class="field">
          <span class="cap">&nbsp;</span>
          <label class="row" style="gap: 4px; font-size: 13px;">
            <input type="checkbox" checked={shift.activated} onchange={(e) => updateShiftTemplate(shift.id, { activated: e.currentTarget.checked })} /> active
          </label>
        </div>
      </div>

      <div class="field">
        <span class="cap">Staffing — people slots</span>
        {#each shift.requirements as r, i (i)}
          {@const remaining = $appData.attributes.filter((a) => !r.attributeIds.includes(a.id))}
          <div class="row" style="margin-bottom: 4px; flex-wrap: wrap;">
            <span class="muted" style="font-size: 13px;">need</span>
            <input type="number" min="1" style="width: 64px;" value={r.count} onchange={(e) => patchTemplateReq(shift.id, i, { count: Math.max(1, Number(e.currentTarget.value)) })} />
            {#if r.attributeIds.length === 0}
              <span class="muted" style="font-size: 13px;">people (anyone)</span>
            {:else}
              <span class="muted" style="font-size: 13px;">people with</span>
              {#each r.attributeIds as aid (aid)}
                <span class="tag">{attrName(aid)}<button title="Remove attribute" onclick={() => removeTemplateReqAttr(shift.id, i, aid)}>×</button></span>
              {/each}
            {/if}
            {#if remaining.length > 0}
              <select value="" onchange={(e) => { addTemplateReqAttr(shift.id, i, e.currentTarget.value); e.currentTarget.value = ""; }}>
                <option value="" disabled>+ attribute…</option>
                {#each remaining as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
              </select>
            {/if}
            <label class="row" style="gap: 4px; font-size: 13px;">
              <input type="checkbox" checked={r.required} onchange={(e) => patchTemplateReq(shift.id, i, { required: e.currentTarget.checked })} /> required
            </label>
            <button class="btn danger icon" onclick={() => removeTemplateReq(shift.id, i)}>×</button>
          </div>
        {/each}
        <div><button class="btn ghost icon" onclick={() => addTemplateReq(shift.id)}>+ people slot</button></div>
      </div>
    </div>
  {/each}
</div>
