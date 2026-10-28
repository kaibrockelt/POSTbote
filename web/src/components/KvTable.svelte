<script>
  import VarField from './VarField.svelte';
  let { rows = $bindable(), withFile = false, toggle = true, keyPlaceholder = 'Key', valuePlaceholder = 'Value', secret = false } = $props();
  const add = () => rows.push({ key: '', value: '', file: '', disabled: false });
</script>

<div class="kv">
  {#each rows as row, i (i)}
    <div class="kv-row" class:off={row.disabled}>
      {#if toggle}
        <input type="checkbox" title="Enabled" checked={!row.disabled} onchange={(e) => (row.disabled = !e.currentTarget.checked)} />
      {/if}
      <VarField class="mono grow" bind:value={row.key} placeholder={keyPlaceholder} />
      <VarField class="mono grow" type={secret ? 'password' : 'text'} bind:value={row.value} placeholder={valuePlaceholder} />
      {#if withFile}
        <VarField class="mono grow" bind:value={row.file} placeholder="or file in collection" />
      {/if}
      <button class="icon" title="Remove" onclick={() => rows.splice(i, 1)}>✕</button>
    </div>
  {/each}
  <button class="link" onclick={add}>+ Add</button>
</div>

<style>
  .kv {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kv-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .off :global(.vf) {
    opacity: 0.45;
  }
</style>
