<script lang="ts">
  import { appData } from "../model/store";
  import {
    mutate,
    addPerson,
    updatePerson,
    removePerson,
    setPersonAttribute,
    removePersonAttribute,
  } from "../model/mutations";
  import type { Person } from "../model/types";

  let newName = $state("");

  function add() {
    const name = newName.trim();
    if (!name) return;
    addPerson(name);
    newName = "";
  }

  function todayISO(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Attribute tags currently on a person, with the attribute object resolved.
  function personTags(personId: string) {
    return $appData.personAttributes
      .filter((pa) => pa.personId === personId)
      .map((pa) => ({ pa, attr: $appData.attributes.find((a) => a.id === pa.attributeId) }))
      .filter((x) => x.attr !== undefined);
  }

  // Attributes not yet assigned to a person (candidates for the add dropdown).
  function attrsToAdd(personId: string) {
    const have = new Set($appData.personAttributes.filter((pa) => pa.personId === personId).map((pa) => pa.attributeId));
    return $appData.attributes.filter((a) => !have.has(a.id));
  }

  // Availability rows for a person, carrying their global index for edit/remove.
  function personAvailability(personId: string) {
    return $appData.availability
      .map((a, i) => ({ a, i }))
      .filter((x) => x.a.personId === personId);
  }

  function setHours(person: Person, rawValue: string, unit: "day" | "week" | "month") {
    const value = rawValue.trim() === "" ? NaN : Number(rawValue);
    updatePerson(person.id, {
      hoursPerTimeframe: Number.isFinite(value) ? { value, unit } : undefined,
    });
  }

  function addAvailability(personId: string) {
    mutate((d) => d.availability.push({ personId, kind: "available", start: todayISO() }));
  }
  function updateAvailability(index: number, patch: Record<string, unknown>) {
    mutate((d) => Object.assign(d.availability[index], patch));
  }
  function removeAvailability(index: number) {
    mutate((d) => d.availability.splice(index, 1));
  }
</script>

<div class="view">
  <h2>People</h2>
  <p class="hint">
    Add people, give them attributes (skills / roles / flags), and record their availability.
    A person's stay is one open-ended <em>available</em> interval; layer <em>unavailable</em>
    intervals on top for days off, vacations, or sick days.
  </p>

  <div class="row" style="margin-bottom: 20px;">
    <input
      placeholder="New person name…"
      bind:value={newName}
      onkeydown={(e) => e.key === "Enter" && add()}
    />
    <button class="btn" onclick={add}>Add person</button>
  </div>

  {#if $appData.persons.length === 0}
    <p class="empty">No people yet.</p>
  {/if}

  {#each $appData.persons as person (person.id)}
    <div class="card">
      <div class="card-head">
        <input
          class="grow"
          value={person.name}
          onchange={(e) => updatePerson(person.id, { name: e.currentTarget.value.trim() })}
          style="font-size: 16px; font-weight: 600;"
        />
        <label class="row" style="gap: 4px; font-size: 13px;">
          <input
            type="checkbox"
            checked={person.activated}
            onchange={(e) => updatePerson(person.id, { activated: e.currentTarget.checked })}
          />
          active
        </label>
        <button
          class="btn danger icon"
          onclick={() => confirm(`Delete "${person.name}" and all their data?`) && removePerson(person.id)}
        >Delete</button>
      </div>

      <!-- Workload target -->
      <div class="row" style="margin-bottom: 12px; font-size: 13px;">
        <span class="muted">Workload target / cap:</span>
        <input
          type="number"
          min="0"
          placeholder="—"
          value={person.hoursPerTimeframe?.value ?? ""}
          onchange={(e) => setHours(person, e.currentTarget.value, person.hoursPerTimeframe?.unit ?? "week")}
        />
        <span class="muted">hours per</span>
        <select
          value={person.hoursPerTimeframe?.unit ?? "week"}
          onchange={(e) => person.hoursPerTimeframe && setHours(person, String(person.hoursPerTimeframe.value), e.currentTarget.value as "day" | "week" | "month")}
        >
          <option value="day">day</option>
          <option value="week">week</option>
          <option value="month">month</option>
        </select>
      </div>

      <!-- Attribute tags -->
      <div class="field" style="margin-bottom: 12px;">
        <span class="cap">Attributes</span>
        <div class="tags">
          {#each personTags(person.id) as { pa, attr } (attr!.id)}
            <span class="tag">
              {attr!.name}
              {#if attr!.valued}
                <input
                  style="width: 70px; padding: 1px 4px;"
                  placeholder="value"
                  value={pa.value ?? ""}
                  onchange={(e) => setPersonAttribute(person.id, attr!.id, e.currentTarget.value.trim() || undefined)}
                />
              {/if}
              <button title="Remove" onclick={() => removePersonAttribute(person.id, attr!.id)}>×</button>
            </span>
          {/each}

          {#if attrsToAdd(person.id).length > 0}
            <select
              value=""
              onchange={(e) => {
                if (e.currentTarget.value) setPersonAttribute(person.id, e.currentTarget.value);
                e.currentTarget.value = "";
              }}
            >
              <option value="" disabled selected>+ add…</option>
              {#each attrsToAdd(person.id) as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
          {:else if $appData.attributes.length === 0}
            <span class="muted" style="font-size: 13px;">Define attributes first.</span>
          {/if}
        </div>
      </div>

      <!-- Availability -->
      <div class="field">
        <span class="cap">Availability</span>
        {#each personAvailability(person.id) as { a, i } (i)}
          <div class="row" style="margin-bottom: 4px;">
            <select value={a.kind} onchange={(e) => updateAvailability(i, { kind: e.currentTarget.value })}>
              <option value="available">available</option>
              <option value="unavailable">unavailable</option>
            </select>
            <input type="date" value={a.start} onchange={(e) => updateAvailability(i, { start: e.currentTarget.value })} />
            <span class="muted">to</span>
            <input
              type="date"
              value={a.end ?? ""}
              onchange={(e) => updateAvailability(i, { end: e.currentTarget.value || undefined })}
            />
            <input
              placeholder="label (optional)"
              value={a.label ?? ""}
              onchange={(e) => updateAvailability(i, { label: e.currentTarget.value.trim() || undefined })}
            />
            <button class="btn danger icon" onclick={() => removeAvailability(i)}>×</button>
          </div>
        {/each}
        <div>
          <button class="btn ghost icon" onclick={() => addAvailability(person.id)}>+ availability interval</button>
        </div>
        <p class="muted" style="font-size: 12px; margin-top: 2px;">
          Leave the end date blank for an open-ended interval.
        </p>
      </div>
    </div>
  {/each}
</div>
