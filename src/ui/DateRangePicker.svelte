<script lang="ts">
  let {
    start,
    end,
    onChange,
  }: { start: string; end: string; onChange: (start: string, end: string) => void } = $props();
</script>

<div class="row">
  <div class="field">
    <span class="cap">From</span>
    <input type="date" value={start} onchange={(e) => onChange(e.currentTarget.value, end)} />
  </div>
  <div class="field">
    <span class="cap">To (inclusive)</span>
    <input type="date" value={end} onchange={(e) => onChange(start, e.currentTarget.value)} />
  </div>
</div>
