<script>
  import { app } from '../lib/state.svelte.js';
  let value = $state('');
  let input = $state();

  $effect(() => {
    if (app.dialog) {
      value = app.dialog.value ?? '';
      queueMicrotask(() => input?.select());
    }
  });

  const close = (v) => app.dialog?.resolve(v);
  function onkeydown(e) {
    if (!app.dialog) return;
    if (e.key === 'Escape') close(app.dialog.type === 'confirm' ? false : null);
  }
  function submit(e) {
    e.preventDefault();
    close(app.dialog.type === 'confirm' ? true : value.trim());
  }
</script>

<svelte:window {onkeydown} />

{#if app.dialog}
  <div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && close(app.dialog.type === 'confirm' ? false : null)}>
    <form class="modal" onsubmit={submit}>
      <h3>{app.dialog.title}</h3>
      {#if app.dialog.message}<p class="muted">{app.dialog.message}</p>{/if}
      {#if app.dialog.type === 'prompt'}
        <input bind:this={input} bind:value placeholder={app.dialog.placeholder || ''} />
        {#if app.dialog.hint}<p class="hint">{app.dialog.hint}</p>{/if}
      {/if}
      <div class="row end gap">
        <button type="button" onclick={() => close(app.dialog.type === 'confirm' ? false : null)}>Cancel</button>
        <button type="submit" class={app.dialog.type === 'confirm' ? 'danger-btn' : 'primary'}>
          {app.dialog.type === 'confirm' ? app.dialog.okLabel || 'OK' : 'OK'}
        </button>
      </div>
    </form>
  </div>
{/if}
