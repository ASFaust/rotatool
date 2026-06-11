<script lang="ts">
  import { appData } from "../model/store";
  import { mutate } from "../model/mutations";

  function nameOf(id: string): string {
    return $appData.persons.find((p) => p.id === id)?.name ?? "?";
  }

  function addPair() {
    const [a, b] = $appData.persons;
    if (!a || !b) return;
    mutate((d) => d.personPreferences.push({ personAId: a.id, personBId: b.id, weight: 1 }));
  }
  function update(index: number, patch: Record<string, unknown>) {
    mutate((d) => Object.assign(d.personPreferences[index], patch));
  }
  function remove(index: number) {
    mutate((d) => d.personPreferences.splice(index, 1));
  }
</script>

<div class="view">
  <h2>Person preferences</h2>
  <p class="hint">
    Pairs of people with a co-assignment preference. Positive weight encourages scheduling them
    together; negative weight discourages it. This is a soft bonus/penalty, so the rota degrades
    gracefully rather than becoming infeasible. Higher absolute weight = stronger effect.
  </p>

  {#if $appData.persons.length < 2}
    <p class="empty">Add at least two people first.</p>
  {:else}
    <table class="data">
      <thead>
        <tr><th>Person A</th><th>Person B</th><th>Weight</th><th></th></tr>
      </thead>
      <tbody>
        {#each $appData.personPreferences as pair, i (i)}
          <tr>
            <td>
              <select value={pair.personAId} onchange={(e) => update(i, { personAId: e.currentTarget.value })}>
                {#each $appData.persons as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
              </select>
            </td>
            <td>
              <select value={pair.personBId} onchange={(e) => update(i, { personBId: e.currentTarget.value })}>
                {#each $appData.persons as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
              </select>
              {#if pair.personAId === pair.personBId}
                <span style="color:#c0392b; font-size:12px;">same person</span>
              {/if}
            </td>
            <td>
              <input type="number" value={pair.weight} onchange={(e) => update(i, { weight: Number(e.currentTarget.value) })} />
            </td>
            <td style="text-align:right;">
              <button class="btn danger icon" onclick={() => remove(i)}>×</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div style="margin-top: 12px;"><button class="btn" onclick={addPair}>Add pair</button></div>
  {/if}
</div>
