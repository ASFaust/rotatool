<script lang="ts">
  import { tick } from "svelte";
  import { appData } from "../model/store";
  import DateRangePicker from "./DateRangePicker.svelte";
  import {
    instanceTemplates,
    clearAssignmentsInRange,
    removeShiftsInRange,
    updateShift,
    removeShift,
    addRequirement,
    updateRequirement,
    removeRequirement,
    setSlotCount,
    assignSlot,
    reconcileAvailability,
    isPersonAvailable,
  } from "../model/ledger";
  import { setLedgerView } from "../model/mutations";
  import { formatDateTime } from "../util/dates";
  import { assignPeople } from "../solver/generate";
  import { ledgerToCsv, ledgerToIcs, ledgerToPrintHtml } from "../persistence/export";

  // --- view range (date-only strings) --------------------------------------
  function addDays(d: Date, n: number): Date {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  function parseDate(s: string): Date {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function fmtDate(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  /** Inclusive day count of a date-only range [from, to]. */
  function inclusiveDays(from: string, to: string): number {
    return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000) + 1;
  }

  // The *selected* range lives in the persisted dataset (appData.ledgerView), so
  // it survives refreshes and travels with imported/example workbooks. It drives
  // Prefill / Assign / Clear / Delete and is highlighted in the timeline.
  const rangeStart = $derived($appData.ledgerView.from);
  const rangeEnd = $derived($appData.ledgerView.to);
  const selFrom = $derived(parseDate(rangeStart));
  const selTo = $derived(addDays(parseDate(rangeEnd), 1)); // end day inclusive

  let viewportW = $state(0); // measured width of the timeline scroll container
  let scrollEl = $state<HTMLDivElement>(); // the horizontal scroll container
  // zoom: 0 = whole window fills the width, 100 = a single day fills the width.
  let zoom = $state(0);
  let selectedId = $state<string | null>(null);
  let status = $state("");
  let busy = $state(false);
  // Display mode: the compact timeline, or the person × day rota grid. Both share
  // the selection (selectedId) and the detail/assignment panel below.
  let displayMode = $state<"timeline" | "grid">("timeline");

  const HOUR_MS = 3_600_000;
  const LANE_H = 50;

  // The *view window* is ephemeral browsing state, decoupled from the selected
  // range: windowStart + N days, shown filling the viewport (N=1 → max zoom-in,
  // large N → zoomed out). Arrows pan it; the "Show days" field sizes it.
  let windowStart = $state(fmtDate(addDays(parseDate($appData.ledgerView.from), -1)));
  let windowDays = $state(inclusiveDays($appData.ledgerView.from, $appData.ledgerView.to) + 2);

  // Selecting a new range jumps the window to range ±1 day (and re-highlights).
  $effect(() => {
    const from = rangeStart;
    const to = rangeEnd;
    windowStart = fmtDate(addDays(parseDate(from), -1));
    windowDays = inclusiveDays(from, to) + 2;
  });

  function pan(deltaDays: number) {
    windowStart = fmtDate(addDays(parseDate(windowStart), deltaDays));
  }
  function setWindowDays(n: number) {
    windowDays = Math.max(1, Math.floor(n) || 1);
  }

  /** Time (ms) to keep centered while zooming: the selected shift, else the viewport center. */
  function zoomAnchorMs(): number {
    if (selected) {
      return new Date(selected.start).getTime() + (selected.durationMinutes * 60_000) / 2;
    }
    if (scrollEl && pxPerHour > 0) {
      const centerPx = scrollEl.scrollLeft + scrollEl.clientWidth / 2;
      return domainStart.getTime() + (centerPx / pxPerHour) * HOUR_MS;
    }
    return domainStart.getTime();
  }

  /** Apply a new zoom level, keeping the anchor centered as the timeline rescales. */
  async function setZoom(v: number) {
    const anchorMs = zoomAnchorMs(); // capture against the pre-zoom scale
    zoom = v;
    await tick(); // let pxPerHour and the timeline width settle
    if (!scrollEl) return;
    const targetPx = ((anchorMs - domainStart.getTime()) / HOUR_MS) * pxPerHour;
    scrollEl.scrollLeft = targetPx - scrollEl.clientWidth / 2;
  }

  const domainStart = $derived(parseDate(windowStart));
  const totalDays = $derived(Math.max(1, windowDays));
  const domainEnd = $derived(addDays(domainStart, totalDays));
  // Days that fill the viewport: whole window when zoomed out, 1 when zoomed in.
  const visibleDays = $derived(totalDays - (zoom / 100) * (totalDays - 1));
  const pxPerHour = $derived(viewportW > 0 ? viewportW / (visibleDays * 24) : 16);
  const totalWidth = $derived(totalDays * 24 * pxPerHour);

  const windowLabel = $derived.by(() => {
    const opts = { day: "2-digit", month: "short", year: "numeric" } as const;
    const a = domainStart.toLocaleDateString("en-GB", opts);
    const b = addDays(domainStart, totalDays - 1).toLocaleDateString("en-GB", opts);
    return `${a} – ${b}`;
  });

  // Shaded band marking the selected range within the (possibly wider) window.
  const highlight = $derived.by(() => {
    const dStart = domainStart.getTime();
    const l = ((selFrom.getTime() - dStart) / HOUR_MS) * pxPerHour;
    const r = ((selTo.getTime() - dStart) / HOUR_MS) * pxPerHour;
    const left = Math.max(0, l);
    const width = Math.max(0, Math.min(totalWidth, r) - left);
    return { left, width };
  });

  // Lay shifts onto lanes: greedy interval partitioning so overlaps stack.
  const layout = $derived.by(() => {
    const dStart = domainStart.getTime();
    const dEnd = domainEnd.getTime();
    const visible = $appData.shifts
      .map((s) => {
        const startMs = new Date(s.start).getTime();
        const endMs = startMs + s.durationMinutes * 60_000;
        return { shift: s, startMs, endMs };
      })
      .filter((b) => b.endMs > dStart && b.startMs < dEnd)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    const laneEnds: number[] = [];
    return visible.map((b) => {
      let lane = laneEnds.findIndex((end) => end <= b.startMs);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(b.endMs);
      } else {
        laneEnds[lane] = b.endMs;
      }
      const left = ((b.startMs - dStart) / HOUR_MS) * pxPerHour;
      const width = Math.max(46, (b.shift.durationMinutes / 60) * pxPerHour);
      // Break trails the shift from its actual end; the line is partly obscured by the block.
      const breakLeft = ((b.endMs - dStart) / HOUR_MS) * pxPerHour;
      const breakWidth = (b.shift.breakMinutes / 60) * pxPerHour;
      return { ...b, lane, left, width, breakLeft, breakWidth };
    });
  });
  const laneCount = $derived(Math.max(1, ...layout.map((b) => b.lane + 1)));

  // --- rota grid (person × day) --------------------------------------------
  // An alternate render of the same shifts, bucketed by start day. Each person
  // row shows the shifts they're assigned to; an extra "Unassigned" row collects
  // shifts that still have an open slot, so they stay clickable/fillable here too.
  function pushTo(map: Map<string, Shift[]>, key: string, s: Shift) {
    const arr = map.get(key);
    if (arr) arr.push(s);
    else map.set(key, [s]);
  }
  const grid = $derived.by(() => {
    const days: { key: string; date: Date }[] = [];
    for (let d = parseDate(rangeStart); d <= parseDate(rangeEnd); d = addDays(d, 1)) {
      days.push({ key: fmtDate(d), date: new Date(d) });
    }
    const inRange = (key: string) => key >= rangeStart && key <= rangeEnd;

    const byPerson = new Map<string, Map<string, Shift[]>>();
    for (const p of $appData.persons) byPerson.set(p.id, new Map());
    const open = new Map<string, Shift[]>();

    for (const s of $appData.shifts) {
      const key = s.start.slice(0, 10);
      if (!inRange(key)) continue;
      const assigned = new Set<string>();
      let hasOpen = s.requirements.length === 0;
      for (const r of s.requirements)
        for (const slot of r.slots) {
          if (slot) assigned.add(slot);
          else hasOpen = true;
        }
      for (const pid of assigned) {
        const m = byPerson.get(pid);
        if (m) pushTo(m, key, s);
      }
      if (hasOpen) pushTo(open, key, s);
    }

    const byStart = (a: Shift, b: Shift) => a.start.localeCompare(b.start);
    for (const m of byPerson.values()) for (const arr of m.values()) arr.sort(byStart);
    for (const arr of open.values()) arr.sort(byStart);

    const anyOpen = open.size > 0;
    return { days, byPerson, open, anyOpen };
  });
  const hhmm = (iso: string) => iso.slice(11, 16);

  const conflicts = $derived(reconcileAvailability($appData));

  // --- fill state -----------------------------------------------------------
  type Shift = (typeof $appData.shifts)[number];
  function fill(s: Shift): { filled: number; total: number } {
    let filled = 0;
    let total = 0;
    for (const r of s.requirements)
      for (const slot of r.slots) {
        total++;
        if (slot !== null) filled++;
      }
    return { filled, total };
  }
  function fillClass(s: Shift): string {
    const { filled, total } = fill(s);
    if (total === 0) return "empty";
    if (filled === 0) return "unfilled";
    if (filled < total) return "partial";
    return "filled";
  }

  // --- selected shift helpers ----------------------------------------------
  const selected = $derived($appData.shifts.find((s) => s.id === selectedId) ?? null);
  const attrName = (id: string) => $appData.attributes.find((a) => a.id === id)?.name ?? "?";
  const personName = (id: string) => $appData.persons.find((p) => p.id === id)?.name ?? "?";

  /** People not already in any slot of this shift (one slot per shift per person). */
  function availablePeople(s: Shift) {
    const taken = new Set<string>();
    for (const r of s.requirements) for (const slot of r.slots) if (slot) taken.add(slot);
    return $appData.persons.filter((p) => !taken.has(p.id));
  }
  function eligible(s: Shift, attributeIds: string[], personId: string): boolean {
    if (attributeIds.length === 0) return true;
    const have = new Set($appData.personAttributes.filter((pa) => pa.personId === personId).map((pa) => pa.attributeId));
    return attributeIds.every((a) => have.has(a));
  }

  const fmtTime = (iso: string) => formatDateTime(iso, { weekday: true });
  const toInput = (iso: string) => iso.slice(0, 16);
  const fromInput = (v: string) => (v.length === 16 ? `${v}:00` : v);

  function addShiftReqAttr(shiftId: string, i: number, attributeId: string) {
    if (!attributeId) return;
    const r = $appData.shifts.find((s) => s.id === shiftId)?.requirements[i];
    if (r && !r.attributeIds.includes(attributeId)) updateRequirement(shiftId, i, { attributeIds: [...r.attributeIds, attributeId] });
  }
  function removeShiftReqAttr(shiftId: string, i: number, attributeId: string) {
    const r = $appData.shifts.find((s) => s.id === shiftId)?.requirements[i];
    if (r) updateRequirement(shiftId, i, { attributeIds: r.attributeIds.filter((a) => a !== attributeId) });
  }

  // --- actions --------------------------------------------------------------
  function doPrefill() {
    try {
      const r = instanceTemplates(selFrom, selTo);
      status = `Prefilled: ${r.created} created, ${r.resynced} re-synced, ${r.removed} removed.`;
    } catch (e) {
      status = "Prefill failed: " + (e instanceof Error ? e.message : e);
    }
  }
  async function doAssign() {
    busy = true;
    status = "Assigning people…";
    try {
      const r = await assignPeople(selFrom, selTo);
      status = `${r.status}: filled ${r.seatsFilled} of ${r.seatsConsidered} open slot(s).`;
    } catch (e) {
      status = "Assign failed: " + e;
    } finally {
      busy = false;
    }
  }
  function doClear() {
    if (!confirm("Clear all people assignments on shifts in this range?")) return;
    const n = clearAssignmentsInRange(selFrom, selTo);
    status = `Cleared ${n} assignment(s).`;
  }
  function doDeleteShifts() {
    if (!confirm("Delete all shifts in this range? This cannot be undone.")) return;
    const n = removeShiftsInRange(selFrom, selTo);
    if (selected && !$appData.shifts.some((s) => s.id === selectedId)) selectedId = null;
    status = `Deleted ${n} shift(s).`;
  }

  // --- export ---------------------------------------------------------------
  function download(filename: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  function doExportCsv() {
    if ($appData.shifts.length === 0) { status = "Nothing to export — no shifts."; return; }
    download("rota.csv", ledgerToCsv($appData), "text/csv");
    status = "Exported rota.csv.";
  }
  function doExportIcs() {
    if ($appData.shifts.length === 0) { status = "Nothing to export — no shifts."; return; }
    download("rota.ics", ledgerToIcs($appData), "text/calendar");
    status = "Exported rota.ics.";
  }
  function doPrint() {
    if ($appData.shifts.length === 0) { status = "Nothing to print — no shifts."; return; }
    const w = window.open("", "_blank");
    if (!w) { status = "Print blocked — allow popups."; return; }
    w.document.write(ledgerToPrintHtml($appData));
    w.document.close();
    w.focus();
    w.print();
  }
</script>

<div class="view wide">
  <h2>Ledger</h2>
  <p class="hint">
    The concrete, dated timeline. <strong>Prefill</strong> instances your repeating templates into
    this range (empty). Adjust shifts and hand-assign people, then <strong>Assign people</strong>
    runs the solver to fill the remaining open slots. Block color shows fill: red = unfilled, amber
    = partial, green = full. Block width ∝ duration; overlaps stack. The selected range is shaded;
    browse freely with the arrows and the “Show days” field below.
  </p>

  <div class="row" style="gap: 16px; align-items: flex-end; margin-bottom: 12px; flex-wrap: wrap;">
    <DateRangePicker start={rangeStart} end={rangeEnd} onChange={setLedgerView} />
    <button class="btn" onclick={doPrefill}>Prefill timeframe</button>
    <button class="btn" onclick={doAssign} disabled={busy}>{busy ? "Assigning…" : "Assign people"}</button>
    <button class="btn ghost" onclick={doClear}>Clear assignments</button>
    <button class="btn danger" onclick={doDeleteShifts}>Delete all shifts in range</button>
    <div class="export-group">
      <span class="cap">Export</span>
      <button class="btn ghost" onclick={doExportCsv}>CSV</button>
      <button class="btn ghost" onclick={doExportIcs}>Calendar (.ics)</button>
      <button class="btn ghost" onclick={doPrint}>Print</button>
    </div>
  </div>

  {#if status}<p class="status-inline">{status}</p>{/if}

  {#if conflicts.length > 0}
    <div class="banner">
      <strong>{conflicts.length} availability conflict(s):</strong>
      <ul>
        {#each conflicts as c}
          <li>{c.personName} on “{c.shiftName}” ({fmtTime(c.start)}) — now outside their availability.</li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Display mode toggle -->
  <div class="row" style="margin-bottom: 8px;">
    <div class="mode-toggle" role="group" aria-label="Display mode">
      <button class="btn ghost" class:active={displayMode === "timeline"} onclick={() => (displayMode = "timeline")}>Timeline</button>
      <button class="btn ghost" class:active={displayMode === "grid"} onclick={() => (displayMode = "grid")}>Grid</button>
    </div>
  </div>

  {#if displayMode === "timeline"}
    <!-- Timeline navigation -->
    <div class="row nav-row">
      <button class="btn ghost icon" title="Back one page" onclick={() => pan(-windowDays)}>«</button>
      <button class="btn ghost icon" title="Back one day" onclick={() => pan(-1)}>‹</button>
      <span class="window-label">{windowLabel}</span>
      <button class="btn ghost icon" title="Forward one day" onclick={() => pan(1)}>›</button>
      <button class="btn ghost icon" title="Forward one page" onclick={() => pan(windowDays)}>»</button>
      <div class="field">
        <span class="cap">Show days</span>
        <input type="number" min="1" style="width: 72px;" value={windowDays} onchange={(e) => setWindowDays(Number(e.currentTarget.value))} />
      </div>
      <div class="field">
        <span class="cap">Zoom</span>
        <input type="range" min="0" max="100" value={zoom} oninput={(e) => setZoom(Number(e.currentTarget.value))} />
      </div>
    </div>

    <!-- Timeline -->
    <div class="timeline-scroll" bind:this={scrollEl} bind:clientWidth={viewportW}>
      <div class="timeline" style="width: {totalWidth}px;">
        {#if highlight.width > 0}
          <div class="range-highlight" style="left: {highlight.left}px; width: {highlight.width}px;"></div>
        {/if}
        <div class="axis" style="width: {totalWidth}px;">
          {#each Array(totalDays) as _, i}
            <div class="day-col" style="left: {i * 24 * pxPerHour}px; width: {24 * pxPerHour}px;">
              <span class="day-label">{addDays(domainStart, i).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}</span>
            </div>
          {/each}
        </div>
        <div class="lanes" style="height: {laneCount * LANE_H}px; width: {totalWidth}px;">
          {#each layout as b (b.shift.id)}
            {#if b.breakWidth > 0}
              <div
                class="break-line"
                style="left: {b.breakLeft}px; width: {b.breakWidth}px; top: {b.lane * LANE_H + LANE_H / 2}px;"
                title="Break: {b.shift.breakMinutes} min"
              ></div>
            {/if}
          {/each}
          {#each layout as b (b.shift.id)}
            {@const f = fill(b.shift)}
            <button
              class="block {fillClass(b.shift)}"
              class:selected={b.shift.id === selectedId}
              style="left: {b.left}px; width: {b.width}px; top: {b.lane * LANE_H}px;"
              onclick={() => (selectedId = b.shift.id)}
              title={b.shift.name}
            >
              <span class="block-title">{b.shift.name}</span>
              <span class="block-people">{f.filled}/{f.total}</span>
            </button>
          {/each}
          {#if layout.length === 0}
            <p class="empty" style="padding: 16px;">No shifts in this range. Use “Prefill timeframe”, or add one-off shifts in the Shifts tab.</p>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <!-- Rota grid: people × days, shifts shown on their start day -->
    {#if $appData.persons.length === 0}
      <p class="empty">No people yet — add some on the People tab.</p>
    {:else if grid.days.length === 0}
      <p class="empty">Empty range — pick a date range above.</p>
    {:else}
      <div class="matrix-scroll">
        <table class="data matrix">
          <thead>
            <tr>
              <th class="corner">Person</th>
              {#each grid.days as d (d.key)}
                <th class="dayhead">
                  <span class="wd">{d.date.toLocaleDateString("en-GB", { weekday: "short" })}</span>
                  <span class="dn">{d.date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" })}</span>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each $appData.persons as p (p.id)}
              {@const row = grid.byPerson.get(p.id)}
              <tr>
                <th class="rowhead">{p.name}</th>
                {#each grid.days as d (d.key)}
                  <td
                    class:away={!isPersonAvailable($appData, p.id, d.date)}
                    title={isPersonAvailable($appData, p.id, d.date) ? undefined : `${p.name} not available`}
                  >
                    {#each row?.get(d.key) ?? [] as s (s.id)}
                      <button
                        class="chip {fillClass(s)}"
                        class:selected={s.id === selectedId}
                        onclick={() => (selectedId = s.id)}
                        title="{s.name} {hhmm(s.start)}"
                      >
                        <span class="c-name">{s.name}</span>
                        <span class="c-time">{hhmm(s.start)}</span>
                      </button>
                    {/each}
                  </td>
                {/each}
              </tr>
            {/each}
            {#if grid.anyOpen}
              <tr class="open-row">
                <th class="rowhead">Unassigned</th>
                {#each grid.days as d (d.key)}
                  <td>
                    {#each grid.open.get(d.key) ?? [] as s (s.id)}
                      {@const f = fill(s)}
                      <button
                        class="chip {fillClass(s)}"
                        class:selected={s.id === selectedId}
                        onclick={() => (selectedId = s.id)}
                        title="{s.name} {hhmm(s.start)} — {f.filled}/{f.total} filled"
                      >
                        <span class="c-name">{s.name}</span>
                        <span class="c-time">{hhmm(s.start)} · {f.filled}/{f.total}</span>
                      </button>
                    {/each}
                  </td>
                {/each}
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}

  <!-- Detail / assignment panel -->
  {#if selected}
    <div class="card" style="margin-top: 16px;">
      <div class="card-head">
        <input class="grow" value={selected.name} onchange={(e) => updateShift(selected.id, { name: e.currentTarget.value.trim() })} style="font-size: 16px; font-weight: 600;" />
        <button class="btn ghost icon" onclick={() => (selectedId = null)}>Close</button>
        <button class="btn danger icon" onclick={() => { removeShift(selected.id); selectedId = null; }}>Delete shift</button>
      </div>

      <div class="row" style="gap: 16px; margin-bottom: 12px; flex-wrap: wrap;">
        <div class="field">
          <span class="cap">Start</span>
          <input type="datetime-local" value={toInput(selected.start)} onchange={(e) => updateShift(selected.id, { start: fromInput(e.currentTarget.value) })} />
        </div>
        <div class="field">
          <span class="cap">Duration (minutes)</span>
          <input type="number" min="1" value={selected.durationMinutes} onchange={(e) => updateShift(selected.id, { durationMinutes: Number(e.currentTarget.value) })} />
        </div>
        <div class="field">
          <span class="cap">Break after (minutes)</span>
          <input type="number" min="0" value={selected.breakMinutes} onchange={(e) => updateShift(selected.id, { breakMinutes: Math.max(0, Number(e.currentTarget.value)) })} />
        </div>
        <div class="field">
          <span class="cap">Importance</span>
          <input type="number" min="0" step="0.5" value={selected.importance} onchange={(e) => updateShift(selected.id, { importance: Math.max(0, Number(e.currentTarget.value)) })} />
        </div>
        <div class="field">
          <span class="cap">Type</span>
          <select value={selected.typeId} onchange={(e) => updateShift(selected.id, { typeId: e.currentTarget.value })}>
            {#each $appData.shiftTypes as st (st.id)}
              <option value={st.id}>{st.name}</option>
            {/each}
          </select>
        </div>
      </div>

      <!-- Requirements + per-slot assignment -->
      {#each selected.requirements as r, i (i)}
        {@const remaining = $appData.attributes.filter((a) => !r.attributeIds.includes(a.id))}
        <div class="req">
          <div class="row" style="margin-bottom: 6px; flex-wrap: wrap;">
            <span class="muted" style="font-size: 13px;">need</span>
            <input type="number" min="1" style="width: 64px;" value={r.slots.length} onchange={(e) => setSlotCount(selected.id, i, Number(e.currentTarget.value))} />
            {#if r.attributeIds.length === 0}
              <span class="muted" style="font-size: 13px;">people (anyone)</span>
            {:else}
              <span class="muted" style="font-size: 13px;">people with</span>
              {#each r.attributeIds as aid (aid)}
                <span class="tag">{attrName(aid)}<button title="Remove attribute" onclick={() => removeShiftReqAttr(selected.id, i, aid)}>×</button></span>
              {/each}
            {/if}
            {#if remaining.length > 0}
              <select value="" onchange={(e) => { addShiftReqAttr(selected.id, i, e.currentTarget.value); e.currentTarget.value = ""; }}>
                <option value="" disabled>+ attribute…</option>
                {#each remaining as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
              </select>
            {/if}
            <label class="row" style="gap: 4px; font-size: 13px;">
              <input type="checkbox" checked={r.required} onchange={(e) => updateRequirement(selected.id, i, { required: e.currentTarget.checked })} /> required
            </label>
            <button class="btn danger icon" onclick={() => removeRequirement(selected.id, i)}>×</button>
          </div>
          <div class="slots">
            {#each r.slots as slot, si (si)}
              {#if slot}
                <span class="tag person-tag" class:warn={!isPersonAvailable($appData, slot, new Date(selected.start))}>
                  {personName(slot)}
                  {#if !isPersonAvailable($appData, slot, new Date(selected.start))}<span title="Unavailable" style="color:#c0392b;">⚠</span>{/if}
                  <button title="Clear" onclick={() => assignSlot(selected.id, i, si, null)}>×</button>
                </span>
              {:else}
                <select value="" onchange={(e) => { if (e.currentTarget.value) assignSlot(selected.id, i, si, e.currentTarget.value); e.currentTarget.value = ""; }}>
                  <option value="" disabled selected>+ assign…</option>
                  {#each availablePeople(selected) as p (p.id)}
                    <option value={p.id}>{p.name}{eligible(selected, r.attributeIds, p.id) ? "" : " (lacks attr)"}{isPersonAvailable($appData, p.id, new Date(selected.start)) ? "" : " (unavailable)"}</option>
                  {/each}
                </select>
              {/if}
            {/each}
          </div>
        </div>
      {/each}
      <div><button class="btn ghost icon" onclick={() => addRequirement(selected.id)}>+ people slot</button></div>
    </div>
  {/if}
</div>

<style>
  .export-group { display: flex; align-items: center; gap: 6px; }
  .export-group .cap { margin-right: 2px; }
  .req { padding: 8px 0; border-top: 1px solid var(--border); }
  .slots { display: flex; flex-wrap: wrap; gap: 6px; }
  .person-tag.warn { border-color: #c0392b; }
  .status-inline {
    font-size: 14px; color: var(--text-h); background: var(--code-bg);
    padding: 6px 10px; border-radius: 6px; margin: 0 0 12px;
  }
  .banner {
    border: 1px solid rgba(192, 57, 43, 0.4); background: rgba(192, 57, 43, 0.08);
    border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; font-size: 14px;
  }
  .banner ul { margin: 6px 0 0; padding-left: 18px; }
  .nav-row { gap: 6px; align-items: center; margin-bottom: 8px; }
  .window-label { font-size: 13px; color: var(--text-h); font-variant-numeric: tabular-nums; min-width: 220px; text-align: center; }
  .timeline-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
  .timeline { position: relative; }
  .range-highlight {
    position: absolute; top: 0; bottom: 0; z-index: 0; pointer-events: none; box-sizing: border-box;
    background: var(--accent-bg); border-left: 2px solid var(--accent); border-right: 2px solid var(--accent);
  }
  .axis { position: relative; height: 28px; border-bottom: 1px solid var(--border); }
  .day-col { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--border); box-sizing: border-box; }
  .day-label { font-size: 12px; color: var(--text); padding: 4px 6px; display: inline-block; white-space: nowrap; }
  .lanes { position: relative; }
  .break-line {
    position: absolute; height: 0; transform: translateY(-50%);
    border-top: 2px dashed var(--text); opacity: 0.4; pointer-events: none;
  }
  .block {
    position: absolute; height: 44px; box-sizing: border-box; margin: 3px 0; padding: 4px 6px;
    border: 2px solid var(--accent-border); background: var(--accent-bg); border-radius: 5px;
    cursor: pointer; overflow: hidden; text-align: left; display: flex; flex-direction: column;
    justify-content: space-between; font: inherit; line-height: 1.2;
  }
  .block:hover { box-shadow: var(--shadow); }
  .block.selected { outline: 2px solid var(--accent); }
  .block.unfilled { border-color: #b02a1c; background: rgba(176, 42, 28, 0.22); }
  .block.partial { border-color: #a06f00; background: rgba(160, 111, 0, 0.24); }
  .block.filled { border-color: #1f8049; background: rgba(31, 128, 73, 0.22); }
  .block-title { font-size: 12px; font-weight: 600; color: var(--text-h); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .block-people { font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; }

  /* Display-mode toggle */
  .mode-toggle { display: inline-flex; gap: 0; }
  .mode-toggle .btn { border-radius: 0; }
  .mode-toggle .btn:first-child { border-radius: 6px 0 0 6px; }
  .mode-toggle .btn:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
  .mode-toggle .btn.active { background: var(--accent-bg); border-color: var(--accent-border); color: var(--accent); }

  /* Rota grid */
  .matrix-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
  .matrix { min-width: max-content; border-collapse: collapse; }
  .matrix th, .matrix td { vertical-align: top; }
  .matrix .corner, .matrix .rowhead {
    text-align: left; position: sticky; left: 0; background: var(--bg); z-index: 1;
  }
  .matrix .rowhead { font-weight: 600; color: var(--text-h); white-space: nowrap; }
  .open-row .rowhead { color: #a06f00; }
  .dayhead { text-align: center; min-width: 92px; line-height: 1.2; }
  .dayhead .wd { display: block; font-size: 11px; color: var(--text); font-weight: 400; }
  .dayhead .dn { display: block; font-variant-numeric: tabular-nums; }
  .matrix td { padding: 3px 4px; }
  /* Day outside a person's availability: hatched grey, dimmed. */
  .matrix td.away {
    background-image: repeating-linear-gradient(
      45deg, transparent, transparent 5px,
      color-mix(in srgb, var(--text) 10%, transparent) 5px,
      color-mix(in srgb, var(--text) 10%, transparent) 10px
    );
    background-color: var(--code-bg);
    opacity: 0.55;
  }
  .chip {
    display: flex; flex-direction: column; gap: 1px; width: 100%; box-sizing: border-box;
    padding: 3px 6px; margin-bottom: 3px; border-radius: 5px; cursor: pointer; text-align: left;
    font: inherit; line-height: 1.2; border: 2px solid var(--accent-border); background: var(--accent-bg);
  }
  .chip:last-child { margin-bottom: 0; }
  .chip:hover { box-shadow: var(--shadow); }
  .chip.selected { outline: 2px solid var(--accent); }
  .chip.unfilled { border-color: #b02a1c; background: rgba(176, 42, 28, 0.22); }
  .chip.partial { border-color: #a06f00; background: rgba(160, 111, 0, 0.24); }
  .chip.filled { border-color: #1f8049; background: rgba(31, 128, 73, 0.22); }
  .chip .c-name { font-size: 12px; font-weight: 600; color: var(--text-h); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chip .c-time { font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
