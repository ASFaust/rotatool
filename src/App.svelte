<script lang="ts">
  import { appData, replaceAppData, resetAppData } from "./model/store";
  import {
    importWorkbook,
    exportWorkbook,
    type CellError,
  } from "./persistence/io";
  import { EXAMPLES, type ExampleTemplate } from "./persistence/examples";
  import PeopleView from "./ui/PeopleView.svelte";
  import AttributesView from "./ui/AttributesView.svelte";
  import ShiftTypesView from "./ui/ShiftTypesView.svelte";
  import ShiftsView from "./ui/ShiftsView.svelte";
  import SolverSettingsView from "./ui/SolverSettingsView.svelte";
  import LedgerView from "./ui/LedgerView.svelte";

  type Tab = "overview" | "people" | "attributes" | "shiftTypes" | "shifts" | "solver" | "ledger";
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "people", label: "People" },
    { id: "attributes", label: "Attributes" },
    { id: "shiftTypes", label: "Shift Types" },
    { id: "shifts", label: "Shifts" },
    { id: "solver", label: "Solver" },
    { id: "ledger", label: "Ledger" },
  ];
  let tab = $state<Tab>("overview");

  let importErrors = $state<CellError[]>([]);
  let status = $state<string>("");
  let fileInput: HTMLInputElement;
  let examplesOpen = $state(false);

  const counts = $derived([
    ["Persons", $appData.persons.length],
    ["Attributes", $appData.attributes.length],
    ["Person attributes", $appData.personAttributes.length],
    ["Availability", $appData.availability.length],
    ["Shift types", $appData.shiftTypes.length],
    ["Shift templates", $appData.shiftTemplates.length],
    ["Shifts (concrete)", $appData.shifts.length],
  ] as const);

  function loadExample(example: ExampleTemplate) {
    replaceAppData(example.create());
    importErrors = [];
    status = `Loaded example "${example.name}".`;
    examplesOpen = false;
  }

  function clearAll() {
    if (!confirm("Discard the current dataset and start empty?")) return;
    resetAppData();
    importErrors = [];
    status = "Cleared.";
  }

  async function onFileChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const { data, errors } = importWorkbook(buffer);
      replaceAppData(data);
      importErrors = errors;
      status =
        errors.length === 0
          ? `Imported "${file.name}" cleanly.`
          : `Imported "${file.name}" with ${errors.length} issue(s) — see Overview.`;
      if (errors.length > 0) tab = "overview";
    } catch (err) {
      status = `Could not read "${file.name}": ${err}`;
    } finally {
      input.value = "";
    }
  }

  function saveWorkbook() {
    const bytes = exportWorkbook($appData);
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rotatool.json";
    a.click();
    URL.revokeObjectURL(url);
    status = "Saved rotatool.json.";
  }
</script>

<header class="topbar">
  <div class="brand">
    <strong>Rotatool</strong>
    <span class="muted">client-side rota generator</span>
  </div>
  <div class="actions">
    <button class="btn ghost" onclick={() => fileInput.click()}>Import .json…</button>
    <button class="btn ghost" onclick={saveWorkbook}>Save .json</button>
    <div class="menu-wrap">
      <button
        class="btn ghost"
        onclick={(e) => {
          e.stopPropagation();
          examplesOpen = !examplesOpen;
        }}
      >
        Load example/template
      </button>
      {#if examplesOpen}
        <div class="menu">
          {#each EXAMPLES as example}
            <button class="menu-item" onclick={() => loadExample(example)}>
              <span class="menu-title">{example.name}</span>
              <span class="menu-desc">{example.description}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button class="btn ghost" onclick={clearAll}>Clear</button>
    <input bind:this={fileInput} type="file" accept=".json" onchange={onFileChosen} hidden />
  </div>
</header>

<svelte:window onclick={() => (examplesOpen = false)} />

<nav class="tabs">
  {#each tabs as t}
    <button class="tab" class:active={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
  {/each}
</nav>

{#if status}
  <p class="status">{status}</p>
{/if}

<main class="content">
  {#if tab === "overview"}
    <div class="view">
      <h2>Overview</h2>
      <p class="hint">Your data never leaves the browser. Save to .json to back up or share.</p>
      <ul class="summary">
        {#each counts as [label, n]}
          <li><span class="count">{n}</span> {label}</li>
        {/each}
      </ul>

      {#if importErrors.length > 0}
        <section style="margin-top: 24px;">
          <h2>Import issues ({importErrors.length})</h2>
          <p class="muted" style="font-size: 14px;">These rows were skipped; everything else loaded.</p>
          <table class="data">
            <thead><tr><th>Location</th><th>Problem</th></tr></thead>
            <tbody>
              {#each importErrors as e}
                <tr><td class="cell-ref">{e.sheet}!{e.cell}</td><td>{e.message}</td></tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/if}
    </div>
  {:else if tab === "people"}
    <PeopleView />
  {:else if tab === "attributes"}
    <AttributesView />
  {:else if tab === "shiftTypes"}
    <ShiftTypesView />
  {:else if tab === "shifts"}
    <ShiftsView />
  {:else if tab === "solver"}
    <SolverSettingsView />
  {:else if tab === "ledger"}
    <LedgerView />
  {/if}
</main>

<style>
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
  }
  .brand strong {
    font-size: 20px;
    color: var(--text-h);
    margin-right: 8px;
  }
  .brand .muted {
    font-size: 13px;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .menu-wrap {
    position: relative;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 10;
    min-width: 320px;
    max-width: 420px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .menu-item {
    font: inherit;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 8px 10px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .menu-item:hover {
    background: var(--accent-bg);
  }
  .menu-title {
    font-weight: 600;
    color: var(--text-h);
    font-size: 14px;
  }
  .menu-desc {
    font-size: 12.5px;
    color: var(--text);
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .tab {
    font: inherit;
    font-size: 15px;
    padding: 10px 14px;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab:hover {
    color: var(--text-h);
  }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .status {
    margin: 16px 24px 0;
    font-size: 14px;
    color: var(--text-h);
    background: var(--code-bg);
    padding: 8px 12px;
    border-radius: 6px;
  }
  .content {
    padding: 24px;
  }
  .summary {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px 24px;
  }
  .summary li {
    font-size: 16px;
  }
  .count {
    display: inline-block;
    min-width: 2ch;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--accent);
  }
  .cell-ref {
    font-family: var(--mono);
    white-space: nowrap;
    color: var(--accent);
  }
</style>
