<script lang="ts">
  let { start = $bindable(), end = $bindable() }: { start: string; end: string } = $props();
</script>

<div class="row">
  <div class="field">
    <span class="cap">From</span>
    <input type="date" bind:value={start} />
  </div>
  <div class="field">
    <span class="cap">To (inclusive)</span>
    <input type="date" bind:value={end} />
  </div>
</div>
