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

  function requirements(shiftId: string) {
    return $appData.shiftRequirements
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.shiftId === shiftId);
  }

  function addRequirement(shiftId: string) {
    const first = $appData.attributes[0];
    if (!first) return;
    mutate((d) => d.shiftRequirements.push({ shiftId, attributeId: first.id, count: 1 }));
  }
  function updateRequirement(index: number, patch: Record<string, unknown>) {
    mutate((d) => Object.assign(d.shiftRequirements[index], patch));
  }
  function removeRequirement(index: number) {
    mutate((d) => d.shiftRequirements.splice(index, 1));
  }
</script>

<div class="view">
  <h2>Shift templates</h2>
  <p class="hint">
    Recurring shift definitions. Each repeats every <em>frequency</em> window starting at the
    <em>anchor</em>; <em>placement</em> controls how fixed each occurrence is. Add
    <em>requirement slots</em> ("need N people with attribute X") to define staffing.
  </p>

  <div class="row" style="margin-bottom: 20px;">
    <input
      placeholder="New shift name…"
      bind:value={newName}
      onkeydown={(e) => e.key === "Enter" && add()}
    />
    <button class="btn" onclick={add}>Add shift</button>
  </div>

  {#if $appData.shiftTemplates.length === 0}
    <p class="empty">No shift templates yet.</p>
  {/if}

  {#each $appData.shiftTemplates as shift (shift.id)}
    <div class="card">
      <div class="card-head">
        <input
          class="grow"
          value={shift.name}
          onchange={(e) => updateShiftTemplate(shift.id, { name: e.currentTarget.value.trim() })}
          style="font-size: 16px; font-weight: 600;"
        />
        <input
          placeholder="type"
          value={shift.type}
          onchange={(e) => updateShiftTemplate(shift.id, { type: e.currentTarget.value.trim() })}
          style="width: 120px;"
        />
        <button
          class="btn danger icon"
          onclick={() => confirm(`Delete shift "${shift.name}"?`) && removeShiftTemplate(shift.id)}
        >Delete</button>
      </div>

      <div class="row" style="gap: 16px; margin-bottom: 12px;">
        <div class="field">
          <span class="cap">Anchor (first occurrence)</span>
          <input
            type="datetime-local"
            value={toInput(shift.activationDateTime)}
            onchange={(e) => updateShiftTemplate(shift.id, { activationDateTime: fromInput(e.currentTarget.value) })}
          />
        </div>
        <div class="field">
          <span class="cap">Duration (minutes)</span>
          <input
            type="number"
            min="1"
            value={shift.durationMinutes}
            onchange={(e) => updateShiftTemplate(shift.id, { durationMinutes: Number(e.currentTarget.value) })}
          />
        </div>
        <div class="field">
          <span class="cap">Repeat every</span>
          <div class="row">
            <input
              type="number"
              min="1"
              value={shift.frequency.value}
              onchange={(e) => updateShiftTemplate(shift.id, { frequency: { ...shift.frequency, value: Number(e.currentTarget.value) } })}
            />
            <select
              value={shift.frequency.unit}
              onchange={(e) => updateShiftTemplate(shift.id, { frequency: { ...shift.frequency, unit: e.currentTarget.value as "days" | "hours" } })}
            >
              <option value="days">days</option>
              <option value="hours">hours</option>
            </select>
          </div>
        </div>
      </div>

      <div class="row" style="gap: 16px; margin-bottom: 12px;">
        <div class="field">
          <span class="cap">Placement</span>
          <select
            value={shift.placement}
            onchange={(e) => updateShiftTemplate(shift.id, { placement: e.currentTarget.value as "strict" | "strictTime" | "anyTime" })}
          >
            <option value="strict">strict (fixed day &amp; time)</option>
            <option value="strictTime">strictTime (fixed time, solver picks day)</option>
            <option value="anyTime">anyTime (solver picks day &amp; time)</option>
          </select>
        </div>
        {#if shift.placement === "anyTime"}
          <div class="field">
            <span class="cap">Candidate slot spacing</span>
            <div class="row">
              <input
                type="number"
                min="1"
                placeholder="1"
                value={shift.anyTimeGranularity?.value ?? ""}
                onchange={(e) => {
                  const v = e.currentTarget.value.trim();
                  updateShiftTemplate(shift.id, {
                    anyTimeGranularity: v === "" ? undefined : { value: Number(v), unit: shift.anyTimeGranularity?.unit ?? "hours" },
                  });
                }}
              />
              <select
                value={shift.anyTimeGranularity?.unit ?? "hours"}
                onchange={(e) => shift.anyTimeGranularity && updateShiftTemplate(shift.id, { anyTimeGranularity: { ...shift.anyTimeGranularity, unit: e.currentTarget.value as "days" | "hours" } })}
              >
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          </div>
        {/if}
        <div class="field">
          <span class="cap">&nbsp;</span>
          <div class="row" style="gap: 16px;">
            <label class="row" style="gap: 4px; font-size: 13px;">
              <input type="checkbox" checked={shift.optional} onchange={(e) => updateShiftTemplate(shift.id, { optional: e.currentTarget.checked })} />
              optional
            </label>
            <label class="row" style="gap: 4px; font-size: 13px;">
              <input type="checkbox" checked={shift.activated} onchange={(e) => updateShiftTemplate(shift.id, { activated: e.currentTarget.checked })} />
              active
            </label>
          </div>
        </div>
      </div>

      <!-- Requirement slots -->
      <div class="field">
        <span class="cap">Staffing — requirement slots</span>
        {#each requirements(shift.id) as { r, i } (i)}
          <div class="row" style="margin-bottom: 4px;">
            <span class="muted" style="font-size: 13px;">need</span>
            <input
              type="number"
              min="1"
              style="width: 64px;"
              value={r.count}
              onchange={(e) => updateRequirement(i, { count: Number(e.currentTarget.value) })}
            />
            <span class="muted" style="font-size: 13px;">people with</span>
            <select value={r.attributeId} onchange={(e) => updateRequirement(i, { attributeId: e.currentTarget.value })}>
              {#each $appData.attributes as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
            <button class="btn danger icon" onclick={() => removeRequirement(i)}>×</button>
          </div>
        {/each}
        {#if $appData.attributes.length === 0}
          <p class="muted" style="font-size: 13px;">Define attributes first to add requirement slots.</p>
        {:else}
          <div><button class="btn ghost icon" onclick={() => addRequirement(shift.id)}>+ requirement slot</button></div>
        {/if}
      </div>
    </div>
  {/each}
</div>
