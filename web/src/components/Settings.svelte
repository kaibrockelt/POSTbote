<script>
  // App-wide settings (gear in the top bar). Sections are added here as
  // global settings appear; collection settings stay in postbote.yaml.
  import { app, setCollectionsDir, pickFolder, fail, toast } from '../lib/state.svelte.js';

  let { onclose } = $props();
  const setup = app.info.setup;
  const local = app.info.mode === 'local' && !!setup?.collectionsDir;
  const initialDir = setup?.collectionsDir || '';
  let dir = $state(initialDir);
  let busy = $state(false);
  const changed = $derived(dir.trim() !== initialDir);

  async function browse() {
    const picked = await pickFolder(dir);
    if (picked) dir = picked;
  }

  async function submit(e) {
    e.preventDefault();
    if (!changed) return onclose();
    busy = true;
    try {
      await setCollectionsDir(dir.trim());
      toast('Collections folder changed');
      onclose();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <form class="modal wide" onsubmit={submit}>
    <h3>Settings</h3>

    {#if local}
      <section>
        <h4>Collections folder</h4>
        <p class="muted">New collections are created here, and every collection folder in it shows up automatically.</p>
        <div class="row gap">
          <input class="mono grow" bind:value={dir} spellcheck="false" aria-label="Collections folder" />
          <button type="button" onclick={browse}>Browse…</button>
        </div>
        {#if dir !== setup.defaultCollectionsDir}
          <button type="button" class="link small" onclick={() => (dir = setup.defaultCollectionsDir)}>Use default ({setup.defaultCollectionsDir})</button>
        {/if}
        <p class="hint">Existing collections are not moved. Collections added from other locations stay available.</p>
      </section>
    {/if}

    <section>
      <h4>About</h4>
      <p class="muted">
        POSTBote {app.info.version} · {app.info.mode === 'local' ? 'local app' : 'team server'}
      </p>
    </section>

    <div class="row end gap">
      <button type="button" onclick={onclose}>{changed ? 'Cancel' : 'Close'}</button>
      {#if local}<button type="submit" class="primary" disabled={!dir.trim() || !changed || busy}>Save</button>{/if}
    </div>
  </form>
</div>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h4 {
    margin: 0;
    font-size: 13px;
  }
  section p {
    margin: 0;
  }
  .link.small {
    align-self: flex-start;
  }
</style>
