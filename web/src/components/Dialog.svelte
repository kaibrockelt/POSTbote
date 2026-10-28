<script>
  import { app } from '../lib/state.svelte.js';
  let value = $state('');
  let paste = $state(''); // optional second field of a prompt (e.g. a pasted cURL command)
  let input = $state();
  let primary = $state();

  $effect(() => {
    if (app.dialog) {
      value = app.dialog.value ?? '';
      paste = '';
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
    if (t === 'prompt' && app.dialog.paste) return close({ value: value.trim(), paste: paste.trim() });
    close(t === 'confirm' ? true : t === 'unsaved' ? 'save' : t === 'info' ? true : value.trim());
  }
  function pasteKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(e);
  }
</script>

<svelte:window {onkeydown} />

{#if app.dialog}
  <div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && close(cancelValue())}>
    <form class="modal" class:wide={app.dialog.paste} onsubmit={submit}>
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
        {#if app.dialog.paste}
          <label class="paste">
            <span class="muted small">{app.dialog.paste.label}</span>
            <textarea class="mono" rows="6" bind:value={paste} placeholder={app.dialog.paste.placeholder || ''} onkeydown={pasteKeydown} spellcheck="false"></textarea>
          </label>
          {#if app.dialog.paste.hint}<p class="hint">{app.dialog.paste.hint}</p>{/if}
        {/if}
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
  .paste {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .paste textarea {
    width: 100%;
    resize: vertical;
    font-size: 12px;
    white-space: pre;
  }
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
