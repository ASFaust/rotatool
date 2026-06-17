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
  import RecurringShiftsView from "./ui/RecurringShiftsView.svelte";
  import OneTimeShiftsView from "./ui/OneTimeShiftsView.svelte";
  import SolverSettingsView from "./ui/SolverSettingsView.svelte";
  import LedgerView from "./ui/LedgerView.svelte";
  import PersonHoursView from "./ui/PersonHoursView.svelte";
  import { solverRun, abortRun } from "./solver/solverLog";

  // While a solve runs, lock data editing app-wide so the snapshot the solver is
  // working from can't shift under it. The running banner (abort + elapsed) and
  // the Solver tab (live log) stay interactive; everything else is inert.
  const run = $derived($solverRun);
  const solving = $derived(run.running);

  type Tab = "overview" | "people" | "shifts" | "ledger";
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "people", label: "People" },
    { id: "shifts", label: "Shifts" },
    { id: "ledger", label: "Rota" },
  ];
  let tab = $state<Tab>("overview");

  type PeopleTab = "directory" | "attributes" | "personHours";
  const peopleTabs: { id: PeopleTab; label: string }[] = [
    { id: "directory", label: "Directory" },
    { id: "attributes", label: "Attributes" },
    { id: "personHours", label: "Person Hours" },
  ];
  let peopleTab = $state<PeopleTab>("directory");

  type ShiftsTab = "recurring" | "oneTime" | "shiftTypes";
  const shiftsTabs: { id: ShiftsTab; label: string }[] = [
    { id: "recurring", label: "Recurring shifts" },
    { id: "oneTime", label: "One-time shifts" },
    { id: "shiftTypes", label: "Shift types" },
  ];
  let shiftsTab = $state<ShiftsTab>("recurring");

  type RotaTab = "timeline" | "grid" | "solver";
  const rotaTabs: { id: RotaTab; label: string }[] = [
    { id: "timeline", label: "Timeline" },
    { id: "grid", label: "Grid" },
    { id: "solver", label: "Solver" },
  ];
  let rotaTab = $state<RotaTab>("timeline");

  let importErrors = $state<CellError[]>([]);
  let status = $state<string>("");
  let fileInput: HTMLInputElement;
  let examplesOpen = $state(false);

  const THEME_KEY = "rotatool-theme";
  function initialTheme(): "light" | "dark" {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  let theme = $state<"light" | "dark">(initialTheme());
  $effect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  });
  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
  }

  const counts = $derived([
    ["Persons", $appData.persons.length],
    ["Attributes", $appData.attributes.length],
    ["Person attributes", $appData.personAttributes.length],
    ["Availability", $appData.availability.length],
    ["Shift types", $appData.shiftTypes.length],
    ["Shift templates", $appData.shiftTemplates.length],
    ["Shifts (concrete)", $appData.shifts.length],
    ["Person-hours (seeded)", $appData.personHours.length],
  ] as const);

  function loadExample(example: ExampleTemplate) {
    if (!confirm(`Discard the current dataset and load "${example.name}"?`)) return;
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
    <button
      class="theme-toggle"
      onclick={toggleTheme}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {#if theme === "dark"}
        <!-- sun: currently dark, click for light -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      {:else}
        <!-- moon: currently light, click for dark -->
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      {/if}
    </button>
    <span class="muted">client-side rota generator</span>
  </div>
  <div class="actions">
    <button class="btn ghost" onclick={() => fileInput.click()} disabled={solving}>Import .json…</button>
    <button class="btn ghost" onclick={saveWorkbook}>Save .json</button>
    <div class="menu-wrap">
      <button
        class="btn ghost"
        disabled={solving}
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
    <button class="btn ghost" onclick={clearAll} disabled={solving}>Clear</button>
    <input bind:this={fileInput} type="file" accept=".json" onchange={onFileChosen} hidden />
  </div>
</header>

<svelte:window onclick={() => (examplesOpen = false)} />

<nav class="tabs">
  {#each tabs as t}
    <button class="tab" class:active={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
  {/each}
</nav>

{#if solving}
  <div class="solving-banner">
    <span class="dot"></span>
    <span class="banner-text">
      Solver running — editing is locked. Watch the log on the <strong>Solver</strong> tab.
    </span>
    <span class="banner-elapsed">{run.elapsedSec}s / {run.timeLimitSec}s</span>
    <button class="btn danger" onclick={abortRun}>Abort solve</button>
  </div>
{/if}

{#if status}
  <p class="status">{status}</p>
{/if}

<main class="content" inert={solving && tab !== "ledger"}>
  {#if tab === "overview"}
    <div class="view">
      <section class="intro">
        <h2>Rotatool</h2>
        <ul class="facts">
          <li>
            <span class="fact-icon" aria-hidden="true">🐢</span>
            <span>
              A free, open-source rota planning tool. Set up your people, shift types
              and constraints, then let the solver build a fair schedule for you.
            </span>
          </li>
          <li>
            <span class="fact-icon" aria-hidden="true">🛡️</span>
            <span>
              <strong>Your data never leaves the browser.</strong>
              Everything runs locally on your device — nothing is uploaded, tracked or
              stored on any server. There's no account and no cookies, so it's GDPR
              compliant by default, simply because no personal data is ever collected.
            </span>
          </li>
          <li>
            <span class="fact-icon" aria-hidden="true">⚠️</span>
            <span>
              The flip side: <strong>nothing is saved for you.</strong> Remember to
              <em>Save .json</em> regularly to keep your work — closing the tab or
              clearing site data will discard anything you haven't exported.
            </span>
          </li>
        </ul>
      </section>

      <h3 class="section-h">Your dataset</h3>
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
    <nav class="subtabs">
      {#each peopleTabs as st}
        <button class="subtab" class:active={peopleTab === st.id} onclick={() => (peopleTab = st.id)}>{st.label}</button>
      {/each}
    </nav>
    {#if peopleTab === "directory"}
      <PeopleView />
    {:else if peopleTab === "attributes"}
      <AttributesView />
    {:else if peopleTab === "personHours"}
      <PersonHoursView />
    {/if}
  {:else if tab === "shifts"}
    <nav class="subtabs">
      {#each shiftsTabs as st}
        <button class="subtab" class:active={shiftsTab === st.id} onclick={() => (shiftsTab = st.id)}>{st.label}</button>
      {/each}
    </nav>
    {#if shiftsTab === "recurring"}
      <RecurringShiftsView />
    {:else if shiftsTab === "oneTime"}
      <OneTimeShiftsView />
    {:else if shiftsTab === "shiftTypes"}
      <ShiftTypesView />
    {/if}
  {:else if tab === "ledger"}
    <nav class="subtabs">
      {#each rotaTabs as rt}
        <button class="subtab" class:active={rotaTab === rt.id} onclick={() => (rotaTab = rt.id)}>{rt.label}</button>
      {/each}
    </nav>
    {#if rotaTab === "solver"}
      <SolverSettingsView />
    {:else}
      <LedgerView mode={rotaTab} />
    {/if}
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
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    margin-right: 8px;
    vertical-align: middle;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-h);
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s;
  }
  .theme-toggle:hover {
    background: var(--accent-bg);
    border-color: var(--accent-border);
    color: var(--accent);
  }
  .theme-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
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
  .subtabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border);
    margin: -20px 0 20px;
    flex-wrap: wrap;
  }
  .subtab {
    font: inherit;
    font-size: 14px;
    padding: 8px 12px;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .subtab:hover {
    color: var(--text-h);
  }
  .subtab.active {
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
  .solving-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 16px 24px 0;
    font-size: 14px;
    color: var(--text-h);
    background: var(--accent-bg);
    border: 1px solid var(--accent-border);
    padding: 8px 12px;
    border-radius: 6px;
  }
  .solving-banner .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .banner-text { flex: 1; }
  .banner-elapsed {
    font-variant-numeric: tabular-nums;
    color: var(--text-h);
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .content {
    padding: 24px;
  }
  .content[inert] { opacity: 0.55; }
  .intro {
    max-width: 720px;
  }
  .facts {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .facts li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    font-size: 16px;
    line-height: 1.55;
    color: var(--text);
  }
  .fact-icon {
    flex: none;
    font-size: 20px;
    line-height: 1.4;
  }
  .facts strong {
    color: var(--text-h);
  }
  .section-h {
    margin: 28px 0 0;
    font-size: 15px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text);
  }
  .summary {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    display: grid;
    grid-template-columns: 1fr;
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
