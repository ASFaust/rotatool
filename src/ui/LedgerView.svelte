<script lang="ts">
  import { appData } from "../model/store";
  import DateRangePicker from "./DateRangePicker.svelte";
  import {
    instanceTemplates,
    clearAssignmentsInRange,
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

  // The timeline window lives in the persisted dataset (appData.ledgerView), so
  // it survives refreshes and travels with imported/example workbooks.
  const rangeStart = $derived($appData.ledgerView.from);
  const rangeEnd = $derived($appData.ledgerView.to);
  // zoom: 0 = fully zoomed out (min(14, days) fill the width), 100 = zoomed in (~1 day fills the width)
  let zoom = $state(0);
  let viewportW = $state(0); // measured width of the timeline scroll container
  let selectedId = $state<string | null>(null);
  let status = $state("");
  let busy = $state(false);

  const HOUR_MS = 3_600_000;
  const LANE_H = 50;

  const domainStart = $derived(parseDate(rangeStart));
  const domainEnd = $derived(addDays(parseDate(rangeEnd), 1)); // end day inclusive
  const totalDays = $derived(Math.max(1, Math.round((domainEnd.getTime() - domainStart.getTime()) / 86_400_000)));
  // Map zoom → days that fill the viewport: 14 (or fewer) when out, 1 when fully in.
  const maxVisibleDays = $derived(Math.min(14, totalDays));
  const visibleDays = $derived(maxVisibleDays - (zoom / 100) * (maxVisibleDays - 1));
  const pxPerHour = $derived(viewportW > 0 ? viewportW / (visibleDays * 24) : 16);
  const totalWidth = $derived(totalDays * 24 * pxPerHour);

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
      const r = instanceTemplates(domainStart, domainEnd);
      status = `Prefilled: ${r.created} created, ${r.resynced} re-synced, ${r.removed} removed.`;
    } catch (e) {
      status = "Prefill failed: " + (e instanceof Error ? e.message : e);
    }
  }
  async function doAssign() {
    busy = true;
    status = "Assigning people…";
    try {
      const r = await assignPeople(domainStart, domainEnd);
      status = `${r.status}: filled ${r.seatsFilled} of ${r.seatsConsidered} open slot(s).`;
    } catch (e) {
      status = "Assign failed: " + e;
    } finally {
      busy = false;
    }
  }
  function doClear() {
    if (!confirm("Clear all people assignments on shifts in this range?")) return;
    const n = clearAssignmentsInRange(domainStart, domainEnd);
    status = `Cleared ${n} assignment(s).`;
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
    = partial, green = full. Block width ∝ duration; overlaps stack.
  </p>

  <div class="row" style="gap: 16px; align-items: flex-end; margin-bottom: 12px; flex-wrap: wrap;">
    <DateRangePicker start={rangeStart} end={rangeEnd} onChange={setLedgerView} />
    <button class="btn" onclick={doPrefill}>Prefill timeframe</button>
    <button class="btn" onclick={doAssign} disabled={busy}>{busy ? "Assigning…" : "Assign people"}</button>
    <button class="btn ghost" onclick={doClear}>Clear assignments</button>
    <div class="field">
      <span class="cap">Zoom</span>
      <input type="range" min="0" max="100" bind:value={zoom} />
    </div>
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

  <!-- Timeline -->
  <div class="timeline-scroll" bind:clientWidth={viewportW}>
    <div class="timeline" style="width: {totalWidth}px;">
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
          <input value={selected.type} onchange={(e) => updateShift(selected.id, { type: e.currentTarget.value.trim() })} />
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
  .timeline-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
  .timeline { position: relative; }
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
    border: 1px solid var(--accent-border); background: var(--accent-bg); border-radius: 5px;
    cursor: pointer; overflow: hidden; text-align: left; display: flex; flex-direction: column;
    justify-content: space-between; font: inherit; line-height: 1.2;
  }
  .block:hover { box-shadow: var(--shadow); }
  .block.selected { outline: 2px solid var(--accent); }
  .block.unfilled { border-color: #c0392b; background: rgba(192, 57, 43, 0.10); }
  .block.partial { border-color: #c79100; background: rgba(199, 145, 0, 0.12); }
  .block.filled { border-color: #2e9e5b; background: rgba(46, 158, 91, 0.12); }
  .block-title { font-size: 12px; font-weight: 600; color: var(--text-h); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .block-people { font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; }
</style>
