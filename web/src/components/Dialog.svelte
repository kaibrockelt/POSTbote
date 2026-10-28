<script>
  import { app } from '../lib/state.svelte.js';
  let value = $state('');
  let input = $state();
  let primary = $state();

  $effect(() => {
    if (app.dialog) {
      value = app.dialog.value ?? '';
      queueMicrotask(() => (app.dialog?.type === 'prompt' ? input?.select() : primary?.focus()));
    }
  });

  // what Esc / clicking outside means for each dialog type
  const cancelValue = () => (app.dialog.type === 'confirm' ? false : null);
  const close = (v) => app.dialog?.resolve(v);
  function onkeydown(e) {
    if (!app.dialog) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close(cancelValue());
    }
  }
  function submit(e) {
    e.preventDefault();
    const t = app.dialog.type;
    close(t === 'confirm' ? true : t === 'unsaved' ? 'save' : t === 'info' ? true : value.trim());
  }
</script>

<svelte:window {onkeydown} />

{#if app.dialog}
  <div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && close(cancelValue())}>
    <form class="modal" onsubmit={submit}>
      <h3>{app.dialog.title}</h3>
      {#if app.dialog.message}<p class="muted msg">{app.dialog.message}</p>{/if}
      {#if app.dialog.items?.length}
        <ul class="items">
          {#each app.dialog.items as item}<li>{item}</li>{/each}
        </ul>
      {/if}
      {#if app.dialog.type === 'prompt'}
        <input bind:this={input} bind:value placeholder={app.dialog.placeholder || ''} />
        {#if app.dialog.hint}<p class="hint">{app.dialog.hint}</p>{/if}
      {/if}
      <div class="row end gap">
        {#if app.dialog.type === 'unsaved'}
          <button type="button" onclick={() => close(null)} title="Esc">Cancel</button>
          <button type="button" class="danger-outline" onclick={() => close('discard')}>Discard</button>
          {#if app.dialog.canSaveAs}<button type="button" onclick={() => close('saveas')}>Save as…</button>{/if}
          <button type="submit" class="primary" bind:this={primary} title="Enter">Save</button>
        {:else if app.dialog.type === 'info'}
          <button type="submit" class="primary" bind:this={primary}>OK</button>
        {:else}
          <button type="button" onclick={() => close(cancelValue())}>Cancel</button>
          <button type="submit" bind:this={primary} class={app.dialog.type === 'confirm' ? 'danger-btn' : 'primary'}>
            {app.dialog.type === 'confirm' ? app.dialog.okLabel || 'OK' : 'OK'}
          </button>
        {/if}
      </div>
    </form>
  </div>
{/if}

<style>
  .msg {
    margin: 0;
  }
  .items {
    margin: 0;
    padding-left: 18px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    max-height: 200px;
    overflow: auto;
  }
  .danger-outline {
    color: var(--bad);
  }
</style>
