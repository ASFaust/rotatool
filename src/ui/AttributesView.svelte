<script lang="ts">
  import { appData } from "../model/store";
  import { addAttribute, updateAttribute, removeAttribute } from "../model/mutations";

  let newName = $state("");

  function add() {
    const name = newName.trim();
    if (!name) return;
    addAttribute(name);
    newName = "";
  }

  function nameTaken(name: string, exceptId: string): boolean {
    const n = name.trim().toLowerCase();
    return $appData.attributes.some((a) => a.id !== exceptId && a.name.toLowerCase() === n);
  }
</script>

<div class="view">
  <h2>Attributes</h2>
  <p class="hint">
    Named properties a person can have and a shift can require — skills, roles, and flags
    like <em>leader</em> or <em>part-time</em> are all attributes. Each is a simple yes/no tag.
  </p>

  <div class="row" style="margin-bottom: 16px;">
    <input
      placeholder="New attribute name…"
      bind:value={newName}
      onkeydown={(e) => e.key === "Enter" && add()}
    />
    <button class="btn" onclick={add}>Add attribute</button>
  </div>

  {#if $appData.attributes.length === 0}
    <p class="empty">No attributes yet.</p>
  {:else}
    <table class="data">
      <thead>
        <tr>
          <th style="width: 60%;">Name</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each $appData.attributes as attr (attr.id)}
          <tr>
            <td>
              <input
                value={attr.name}
                onchange={(e) => updateAttribute(attr.id, { name: e.currentTarget.value.trim() })}
                style="width: 100%;"
              />
              {#if nameTaken(attr.name, attr.id)}
                <span class="muted" style="color:#c0392b; font-size:12px;">duplicate name</span>
              {/if}
            </td>
            <td style="text-align:right;">
              <button
                class="btn danger icon"
                onclick={() => confirm(`Delete attribute "${attr.name}"? It will be removed from people and shift requirements.`) && removeAttribute(attr.id)}
              >Delete</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
