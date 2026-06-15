<script lang="ts">
  let {
    start,
    end,
    onChange,
  }: { start: string; end: string; onChange: (start: string, end: string) => void } = $props();

  // Keep the window ordered: if an edit would invert it (from > to), drag the
  // other endpoint along so the range never collapses. An inverted range makes
  // the Ledger silently empty (occurrences() bails when rangeEnd <= rangeStart).
  function changeFrom(from: string) {
    onChange(from, from > end ? from : end);
  }
  function changeTo(to: string) {
    onChange(to < start ? to : start, to);
  }
</script>

<div class="row">
  <div class="field">
    <span class="cap">From</span>
    <input type="date" value={start} max={end} onchange={(e) => changeFrom(e.currentTarget.value)} />
  </div>
  <div class="field">
    <span class="cap">To (inclusive)</span>
    <input type="date" value={end} min={start} onchange={(e) => changeTo(e.currentTarget.value)} />
  </div>
</div>
