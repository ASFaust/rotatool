<script lang="ts">
  import { appData, replaceAppData, resetAppData } from "./model/store";
  import {
    importWorkbook,
    exportWorkbook,
    createSeedData,
    type CellError,
  } from "./persistence/io";

  // Errors from the most recent import (cleared on a clean load).
  let importErrors = $state<CellError[]>([]);
  let status = $state<string>("");
  let fileInput: HTMLInputElement;

  // Live row counts for each sheet, derived from the store.
  const counts = $derived([
    ["Persons", $appData.persons.length],
    ["Attributes", $appData.attributes.length],
    ["Person attributes", $appData.personAttributes.length],
    ["Availability", $appData.availability.length],
    ["Shift templates", $appData.shiftTemplates.length],
    ["Shift requirements", $appData.shiftRequirements.length],
    ["Animosity pairs", $appData.animosity.length],
    ["Preferences", $appData.preferences.length],
    ["Ledger shifts", $appData.ledgerShifts.length],
    ["Ledger assignments", $appData.ledgerAssignments.length],
  ] as const);

  const totalRows = $derived(counts.reduce((sum, [, n]) => sum + n, 0));

  function loadExample() {
    replaceAppData(createSeedData());
    importErrors = [];
    status = "Loaded the example dataset.";
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
          : `Imported "${file.name}" with ${errors.length} issue(s) — see below.`;
    } catch (err) {
      status = `Could not read "${file.name}": ${err}`;
    } finally {
      input.value = ""; // allow re-selecting the same file
    }
  }

  function saveWorkbook() {
    const bytes = exportWorkbook($appData);
    // Copy into a fresh ArrayBuffer-backed view (satisfies BlobPart typing).
    const blob = new Blob([new Uint8Array(bytes)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rotatool.xlsx";
    a.click();
    URL.revokeObjectURL(url);
    status = "Saved rotatool.xlsx.";
  }
</script>

<main>
  <header>
    <h1>Rotatool</h1>
    <p class="tagline">Client-side rota generator — your data never leaves the browser.</p>
  </header>

  <div class="toolbar">
    <button onclick={() => fileInput.click()}>Import .xlsx…</button>
    <button onclick={saveWorkbook}>Save .xlsx</button>
    <button onclick={loadExample}>Load example</button>
    <button class="ghost" onclick={clearAll}>Clear</button>
    <input
      bind:this={fileInput}
      type="file"
      accept=".xlsx"
      onchange={onFileChosen}
      hidden
    />
  </div>

  {#if status}
    <p class="status">{status}</p>
  {/if}

  <section class="summary">
    <h2>Loaded data <span class="muted">({totalRows} rows)</span></h2>
    <ul>
      {#each counts as [label, n]}
        <li><span class="count">{n}</span> {label}</li>
      {/each}
    </ul>
  </section>

  {#if importErrors.length > 0}
    <section class="errors">
      <h2>Import issues ({importErrors.length})</h2>
      <p class="muted">These rows were skipped; everything else loaded.</p>
      <table>
        <thead>
          <tr><th>Location</th><th>Problem</th></tr>
        </thead>
        <tbody>
          {#each importErrors as e}
            <tr>
              <td class="cell-ref">{e.sheet}!{e.cell}</td>
              <td>{e.message}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 24px 80px;
    text-align: left;
  }
  header h1 {
    margin: 0 0 4px;
    font-size: 40px;
  }
  .tagline {
    color: var(--text);
    margin-bottom: 24px;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
  }
  button {
    font: inherit;
    font-size: 15px;
    padding: 8px 14px;
    border-radius: 6px;
    border: 1px solid var(--accent-border);
    background: var(--accent-bg);
    color: var(--text-h);
    cursor: pointer;
    transition: box-shadow 0.2s;
  }
  button:hover {
    box-shadow: var(--shadow);
  }
  button.ghost {
    background: transparent;
    border-color: var(--border);
  }
  .status {
    font-size: 15px;
    color: var(--text-h);
    background: var(--code-bg);
    padding: 8px 12px;
    border-radius: 6px;
    margin-bottom: 20px;
  }
  .summary ul {
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
  .muted {
    color: var(--text);
    font-weight: 400;
    font-size: 15px;
  }
  .errors {
    margin-top: 28px;
  }
  .errors table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    margin-top: 8px;
  }
  .errors th,
  .errors td {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .cell-ref {
    font-family: var(--mono);
    white-space: nowrap;
    color: var(--accent);
  }
</style>
