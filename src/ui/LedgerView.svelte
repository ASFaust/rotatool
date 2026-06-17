<script lang="ts">
  import { tick } from "svelte";
  import { flip } from "svelte/animate";
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
  import { personStartDate } from "../model/hours";
  import { setLedgerView } from "../model/mutations";
  import { formatDateTime } from "../util/dates";
  import { solverRun, runAssign } from "../solver/solverLog";
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

  // Display mode is driven by the Rota sub-tab (Timeline / Grid). Both modes share
  // the selection (selectedId), the action bar, and the detail/assignment panel.
  let { mode = "timeline" }: { mode?: "timeline" | "grid" } = $props();

  let viewportW = $state(0); // measured width of the timeline scroll container
  let scrollEl = $state<HTMLDivElement>(); // the horizontal scroll container
  // zoom: 0 = whole window fills the width, 100 = a single day fills the width.
  let zoom = $state(0);
  let selectedId = $state<string | null>(null);
  // Person whose chip is selected (a specific assigned slot), so Del can unassign
  // them. null when the selection is a shift-level chip (open row / timeline).
  let selectedPid = $state<string | null>(null);
  let status = $state("");
  // The solve run lives in a shared store so it survives this tab unmounting
  // (the solver keeps going while you browse). `solving` also locks editing.
  const run = $derived($solverRun);
  const solving = $derived(run.running);
  const progress = $derived(
    run.timeLimitSec > 0 ? Math.min(1, run.elapsedSec / run.timeLimitSec) : 0,
  );
  const lastLine = $derived(run.lines.length ? run.lines[run.lines.length - 1] : "");

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

  // Rota-grid chips are tinted by their shift type's color: the type color as
  // border, a translucent wash of it as background.
  const typeColor = (typeId: string) =>
    $appData.shiftTypes.find((t) => t.id === typeId)?.color ?? "#9ca3af";
  const chipStyle = (s: Shift) => {
    const c = typeColor(s.typeId);
    return `border-color: ${c}; background: color-mix(in srgb, ${c} 18%, transparent);`;
  };

  const conflicts = $derived(reconcileAvailability($appData));

  // --- drag-to-reassign (grid) ---------------------------------------------
  // A chip in person P's row is one filled slot of a shift, tagged with its
  // role (the requirement's `label`). A shift never moves between days, only
  // between people. While a chip is being dragged we *hide* every person row
  // that isn't a valid target, so the grid collapses to just the people you can
  // drop on. Dropping an Unassigned chip (fromPid = null) fills the shift's
  // first open slot for that role; dropping any chip on the Unassigned row
  // clears it.
  type DragPayload = { shiftId: string; fromPid: string | null };
  let drag = $state<DragPayload | null>(null);
  let hoverPid = $state<string | null>(null); // person row currently hovered

  /** Day (yyyy-mm-dd) of the shift being dragged — other day columns grey out. */
  const dragDayKey = $derived.by(() => {
    if (!drag) return null;
    const s = $appData.shifts.find((x) => x.id === drag!.shiftId);
    return s ? s.start.slice(0, 10) : null;
  });

  // Native HTML5 drag suppresses normal scrolling, so we auto-scroll when the
  // pointer nears a viewport edge: the window vertically, the grid horizontally.
  let matrixScrollEl = $state<HTMLDivElement | null>(null);
  let dragX = 0, dragY = 0;
  let autoScrollRAF = 0;

  function autoScrollTick() {
    if (!drag) { autoScrollRAF = 0; return; }
    const margin = 72, maxSpeed = 22;
    const edge = (pos: number, lo: number, hi: number) =>
      pos < lo + margin ? -Math.ceil(((lo + margin - pos) / margin) * maxSpeed)
      : pos > hi - margin ? Math.ceil(((pos - (hi - margin)) / margin) * maxSpeed)
      : 0;
    const dy = edge(dragY, 0, window.innerHeight);
    if (dy) window.scrollBy(0, dy);
    if (matrixScrollEl) {
      const r = matrixScrollEl.getBoundingClientRect();
      const dx = edge(dragX, r.left, r.right);
      if (dx) matrixScrollEl.scrollLeft += dx;
    }
    autoScrollRAF = requestAnimationFrame(autoScrollTick);
  }
  function onDragMove(e: DragEvent) {
    if (!drag) return;
    dragX = e.clientX; dragY = e.clientY;
    if (!autoScrollRAF) autoScrollRAF = requestAnimationFrame(autoScrollTick);
  }

  function findSlot(s: Shift, pid: string): { ri: number; si: number } | null {
    for (let ri = 0; ri < s.requirements.length; ri++) {
      const si = s.requirements[ri].slots.indexOf(pid);
      if (si !== -1) return { ri, si };
    }
    return null;
  }
  function firstOpenSlot(s: Shift): { ri: number; si: number } | null {
    for (let ri = 0; ri < s.requirements.length; ri++) {
      const si = s.requirements[ri].slots.indexOf(null);
      if (si !== -1) return { ri, si };
    }
    return null;
  }
  /** The requirement a drop would land in: the source's slot (reassign) or the first open one. */
  function targetReq(s: Shift): { ri: number; si: number } | null {
    if (!drag) return null;
    return drag.fromPid !== null ? findSlot(s, drag.fromPid) : firstOpenSlot(s);
  }
  /** Role name of the requirement holding `pid` in `s` (or of the first open slot). */
  function roleOf(s: Shift, pid: string | null): string {
    const at = pid !== null ? findSlot(s, pid) : firstOpenSlot(s);
    return (at && s.requirements[at.ri].label) || "";
  }

  /** Whether `pid` already fills any slot of a *different* shift that overlaps `s` in time. */
  function hasTimeClash(s: Shift, pid: string): boolean {
    const aStart = new Date(s.start).getTime();
    const aEnd = aStart + s.durationMinutes * 60_000;
    for (const o of $appData.shifts) {
      if (o.id === s.id) continue;
      const bStart = new Date(o.start).getTime();
      const bEnd = bStart + o.durationMinutes * 60_000;
      if (bStart >= aEnd || bEnd <= aStart) continue; // no time overlap
      if (o.requirements.some((r) => r.slots.includes(pid))) return true;
    }
    return false;
  }

  /** Can the dragged chip be physically reassigned to `pid`? Not the source, not
   *  already in the shift, and there's a slot to fill. Allowed even as an
   *  override (unavailable / unqualified / time clash) so swaps are possible. */
  function canAssignPerson(pid: string): boolean {
    if (!drag) return false;
    const s = $appData.shifts.find((x) => x.id === drag!.shiftId);
    if (!s) return false;
    if (pid === drag.fromPid || findSlot(s, pid)) return false; // source, or already in shift
    return targetReq(s) !== null; // a slot exists to fill
  }
  /** A *clean* target: assignable AND available, qualified, no time clash. These
   *  rows stay expanded; everything else collapses to a name-only strip. */
  function canDropPerson(pid: string): boolean {
    if (!canAssignPerson(pid)) return false;
    const s = $appData.shifts.find((x) => x.id === drag!.shiftId)!;
    const tgt = targetReq(s)!;
    return (
      !hasTimeClash(s, pid) &&
      isPersonAvailable($appData, pid, new Date(s.start)) &&
      eligible(s, s.requirements[tgt.ri].attributeIds, pid)
    );
  }

  // While dragging, gather eligible targets next to the row you're dragging
  // from — WITHOUT moving that row. Trick: reorder the people *above* the source
  // only among themselves and the people *below* only among themselves. Each
  // group keeps the same members (so its total height is unchanged), which pins
  // the source row's screen position; eligible rows just bubble to the edge of
  // their group nearest the source. Dragging from Unassigned (no source row in
  // the list) keeps the person set intact and floats eligible rows to the
  // bottom, next to the Unassigned row. FLIP animates the shuffle smoothly.
  // Default row order: by each person's start date (earliest available interval),
  // so the longest-tenured people are at the top. People without a start date
  // sink to the bottom, keeping their stored order.
  const sortedPersons = $derived.by(() => {
    const persons = $appData.persons;
    const started = new Map<string, number>();
    for (const p of persons) {
      const d = personStartDate($appData, p.id);
      if (d) started.set(p.id, d.getTime());
    }
    return persons
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        const ea = started.get(a.p.id), eb = started.get(b.p.id);
        if (ea === undefined || eb === undefined) return (ea ? 0 : 1) - (eb ? 0 : 1) || a.i - b.i;
        return ea === eb ? a.i - b.i : ea - eb;
      })
      .map((x) => x.p);
  });

  const orderedPersons = $derived.by(() => {
    const persons = sortedPersons;
    if (!drag) return persons;
    const good = (p: (typeof persons)[number]) => canDropPerson(p.id);
    if (drag.fromPid === null) {
      return [...persons.filter((p) => !good(p)), ...persons.filter(good)];
    }
    const k = persons.findIndex((p) => p.id === drag!.fromPid);
    if (k === -1) return persons;
    const above = persons.slice(0, k);
    const below = persons.slice(k + 1);
    return [
      ...above.filter((p) => !good(p)), ...above.filter(good), // eligible sink to just above source
      persons[k],
      ...below.filter(good), ...below.filter((p) => !good(p)), // eligible rise to just below source
    ];
  });

  function onDropPerson(pid: string) {
    if (drag && canAssignPerson(pid)) {
      const s = $appData.shifts.find((x) => x.id === drag!.shiftId)!;
      const tgt = targetReq(s)!;
      assignSlot(s.id, tgt.ri, tgt.si, pid);
    }
    drag = null;
    hoverPid = null;
  }
  function onDropUnassigned() {
    if (drag && drag.fromPid !== null) {
      const s = $appData.shifts.find((x) => x.id === drag!.shiftId);
      const from = s && findSlot(s, drag.fromPid);
      if (s && from) assignSlot(s.id, from.ri, from.si, null);
    }
    drag = null;
    hoverPid = null;
  }

  // Clicking the background — anywhere that isn't a chip, a timeline block, or
  // the detail panel — clears the selection.
  function onBackgroundClick(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (t?.closest(".chip, .block, .card")) return;
    selectedId = null;
    selectedPid = null;
  }

  // Del / Backspace with a person's chip selected unassigns them from that shift.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!selectedId || !selectedPid) return;
    const s = $appData.shifts.find((x) => x.id === selectedId);
    const at = s && findSlot(s, selectedPid);
    if (s && at) {
      e.preventDefault();
      assignSlot(s.id, at.ri, at.si, null);
      selectedPid = null;
    }
  }

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
    status = "";
    await runAssign(selFrom, selTo);
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

<svelte:window ondragover={onDragMove} onkeydown={onKeyDown} onclick={onBackgroundClick} />

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
    <button class="btn" onclick={doPrefill} disabled={solving}>Place shifts</button>
    <button class="btn" onclick={doAssign} disabled={solving}>Assign people</button>
    <button class="btn ghost" onclick={doClear} disabled={solving}>Clear assignments</button>
    <button class="btn danger" onclick={doDeleteShifts} disabled={solving}>Delete all shifts in range</button>
    <div class="export-group">
      <span class="cap">Export</span>
      <button class="btn ghost" onclick={doExportCsv} disabled={solving}>CSV</button>
      <button class="btn ghost" onclick={doExportIcs} disabled={solving}>Calendar (.ics)</button>
      <button class="btn ghost" onclick={doPrint} disabled={solving}>Print</button>
    </div>
  </div>

  {#if solving}
    <div class="solve-progress">
      <div class="solve-head">
        <span class="spinner" aria-hidden="true"></span>
        <span class="solve-label">Solving… {run.elapsedSec}s / {run.timeLimitSec}s</span>
        {#if run.gap !== null}<span class="solve-gap">gap {(run.gap * 100).toFixed(1)}%</span>{/if}
      </div>
      <div class="bar"><div class="bar-fill" style="width: {(progress * 100).toFixed(1)}%"></div></div>
      {#if lastLine}<code class="solve-last">{lastLine}</code>{/if}
      <p class="sub">Editing is locked while solving. Full solver output is on the <strong>Solver</strong> tab.</p>
    </div>
  {:else if status}
    <p class="status-inline">{status}</p>
  {:else if run.message}
    <p class="status-inline">{run.message}</p>
  {/if}

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

  {#if mode === "timeline"}
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
              onclick={() => { selectedId = b.shift.id; selectedPid = null; }}
              title={b.shift.name}
            >
              <span class="block-title">{b.shift.name}</span>
              <span class="block-people">{f.filled}/{f.total}</span>
            </button>
          {/each}
          {#if layout.length === 0}
            <p class="empty" style="padding: 16px;">No shifts in this range. Use “Place shifts”, or add one-time shifts in the Shifts tab.</p>
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
      <div class="matrix-scroll" bind:this={matrixScrollEl}>
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
            {#each orderedPersons as p (p.id)}
              {@const row = grid.byPerson.get(p.id)}
              {@const droppable = !!drag && canDropPerson(p.id)}
              {@const assignable = !!drag && canAssignPerson(p.id)}
              {@const hovered = hoverPid === p.id}
              {@const rowDim = !!drag && !droppable}
              <tr
                animate:flip={{ duration: 180 }}
                class:drop-hover={droppable && hovered}
                class:drop-hover-warn={assignable && !droppable && hovered}
                ondragover={(e) => { if (assignable) { e.preventDefault(); hoverPid = p.id; } }}
                ondragleave={() => { if (hovered) hoverPid = null; }}
                ondrop={(e) => { if (assignable) { e.preventDefault(); onDropPerson(p.id); } }}
              >
                <th class="rowhead" class:dim={rowDim}>{p.name}</th>
                {#each grid.days as d (d.key)}
                  <td
                    class:away={!isPersonAvailable($appData, p.id, d.date)}
                    class:dim={!!drag && (rowDim || d.key !== dragDayKey)}
                    title={isPersonAvailable($appData, p.id, d.date) ? undefined : `${p.name} not available`}
                  >
                    {#each row?.get(d.key) ?? [] as s (s.id)}
                      {@const role = roleOf(s, p.id)}
                      <button
                        class="chip"
                        class:shift-active={s.id === selectedId}
                        class:selected={s.id === selectedId && selectedPid === p.id}
                        class:dragging={drag?.shiftId === s.id && drag?.fromPid === p.id}
                        style={chipStyle(s)}
                        draggable={!solving}
                        ondragstart={() => (drag = { shiftId: s.id, fromPid: p.id })}
                        ondragend={() => { drag = null; hoverPid = null; }}
                        onclick={() => { selectedId = s.id; selectedPid = p.id; }}
                        title="{s.name}{role ? ` — ${role}` : ''} {hhmm(s.start)} — drag to reassign · Del to unassign"
                      >
                        <span class="c-name">{s.name}</span>
                        {#if role}<span class="c-role">{role}</span>{/if}
                        <span class="c-time">{hhmm(s.start)}</span>
                      </button>
                    {/each}
                  </td>
                {/each}
              </tr>
            {/each}
            {#if grid.anyOpen}
              {@const clearHere = !!drag && drag.fromPid !== null}
              <tr
                class="open-row"
                class:drop-clear={clearHere && hoverPid === "__open__"}
                ondragover={(e) => { if (clearHere) { e.preventDefault(); hoverPid = "__open__"; } }}
                ondragleave={() => { if (hoverPid === "__open__") hoverPid = null; }}
                ondrop={(e) => { if (clearHere) { e.preventDefault(); onDropUnassigned(); } }}
              >
                <th class="rowhead">Unassigned</th>
                {#each grid.days as d (d.key)}
                  <td class:dim={!!drag && d.key !== dragDayKey}>
                    {#each grid.open.get(d.key) ?? [] as s (s.id)}
                      {@const f = fill(s)}
                      {@const role = roleOf(s, null)}
                      <button
                        class="chip"
                        class:shift-active={s.id === selectedId}
                        class:selected={s.id === selectedId && selectedPid === null}
                        class:dragging={drag?.shiftId === s.id && drag?.fromPid === null}
                        style={chipStyle(s)}
                        draggable={!solving}
                        ondragstart={() => (drag = { shiftId: s.id, fromPid: null })}
                        ondragend={() => { drag = null; hoverPid = null; }}
                        onclick={() => { selectedId = s.id; selectedPid = null; }}
                        title="{s.name}{role ? ` — open: ${role}` : ''} {hhmm(s.start)} — {f.filled}/{f.total} filled · drag onto a person to assign"
                      >
                        <span class="c-name">{s.name}</span>
                        {#if role}<span class="c-role">{role}</span>{/if}
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
    <div class="card" style="margin-top: 16px;" inert={solving}>
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
            <input
              type="text"
              class="role-input"
              placeholder="role name…"
              value={r.label ?? ""}
              onchange={(e) => updateRequirement(selected.id, i, { label: e.currentTarget.value.trim() || undefined })}
            />
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
      <div><button class="btn ghost icon" onclick={() => addRequirement(selected.id)}>+ role</button></div>
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
  .card[inert] { opacity: 0.5; }
  .solve-progress {
    background: var(--code-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 14px; margin: 0 0 12px;
  }
  .solve-head { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text-h); }
  .solve-label { font-variant-numeric: tabular-nums; }
  .solve-gap { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--accent); }
  .bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin: 8px 0 6px; }
  .bar-fill { height: 100%; background: var(--accent); transition: width 0.4s linear; }
  .solve-last {
    display: block; font-size: 12px; color: var(--text); white-space: pre; overflow-x: auto;
    font-variant-numeric: tabular-nums;
  }
  .solve-progress .sub { font-size: 12px; color: var(--text); margin: 6px 0 0; }
  .spinner {
    width: 13px; height: 13px; border: 2px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.8s linear infinite; flex: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
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
  /* All chips of the selected shift get a dashed ring (grouping cue); the exact
     chip you clicked gets a solid ring — shape difference, not just colour. */
  .chip.shift-active { outline: 2px dashed var(--accent); outline-offset: 1px; }
  .chip.selected { outline: 2px solid var(--accent); outline-offset: 0; }
  .chip .c-name { font-size: 12px; font-weight: 600; color: var(--text-h); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chip .c-time { font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .chip .c-role {
    font-size: 11px; font-weight: 600; color: var(--text-h); opacity: 0.85;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .chip[draggable="true"] { cursor: grab; }
  .chip.dragging { opacity: 0.4; }
  .role-input { width: 120px; font-weight: 600; }
  /* Drag-to-reassign: while dragging, eligible rows gather next to the source
     row (which stays put). Ineligible cells — wrong person, or a day other than
     the dragged shift's — grey out so valid targets stand out by contrast.
     The Unassigned row doubles as a "clear" target. */
  .matrix td.dim, .matrix th.dim { filter: grayscale(1); }
  /* Grey tint on the cell itself so empty ineligible cells read differently from empty eligible ones. */
  .matrix td.dim { background-color: color-mix(in srgb, var(--text) 7%, transparent); }
  .matrix td.dim .chip { opacity: 0.3; }
  .matrix th.dim { opacity: 0.3; }
  .matrix tr.drop-hover th, .matrix tr.drop-hover td { background-color: color-mix(in srgb, var(--accent) 20%, transparent); }
  /* Override drop (unavailable / unqualified / clash) — droppable, but warned in amber. */
  .matrix tr.drop-hover-warn th, .matrix tr.drop-hover-warn td { background-color: rgba(160, 111, 0, 0.22); }
  .matrix tr.drop-clear th, .matrix tr.drop-clear td { background-color: color-mix(in srgb, var(--text) 14%, transparent); }
</style>
