<script>
  // First-run wizard of the local/desktop app. Changing the folder later
  // happens in Settings.
  import { app, setCollectionsDir, createWorkspace, pickFolder, fail } from '../lib/state.svelte.js';
  import { scaffold } from '../lib/format.js';

  const setup = app.info.setup;
  let dir = $state(setup.collectionsDir || setup.defaultCollectionsDir);
  let example = $state(true);
  let busy = $state(false);

  async function browse() {
    const picked = await pickFolder(dir);
    if (picked) dir = picked;
  }

  async function submit(e) {
    e.preventDefault();
    busy = true;
    try {
      await setCollectionsDir(dir);
      if (example && !app.workspaces.length) {
        await createWorkspace({ name: 'Example', storage: 'disk', files: scaffold('Example') });
      }
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="backdrop">
  <form class="modal wide" onsubmit={submit}>
    <div class="hero">
      <img src="/favicon.svg" alt="" width="40" height="40" />
      <div>
        <h2>Welcome to POSTBote</h2>
        <p class="muted">An API client that keeps everything on your machine: no account, no cloud.</p>
      </div>
    </div>
    <p>
      Your collections are stored as plain text files – one folder per collection – so you can version them with git or sync them
      however you like. Where should they live?
    </p>

    <label class="field">
      <span>Collections folder</span>
      <div class="row gap">
        <input class="mono grow" bind:value={dir} spellcheck="false" />
        <button type="button" onclick={browse}>Browse…</button>
      </div>
    </label>
    {#if dir !== setup.defaultCollectionsDir}
      <button type="button" class="link small" onclick={() => (dir = setup.defaultCollectionsDir)}>Use default ({setup.defaultCollectionsDir})</button>
    {/if}

    <label class="check"><input type="checkbox" bind:checked={example} /> Create an example collection to get started</label>
    <p class="hint">You can change the folder later, and add collections that live elsewhere (e.g. inside a project repository).</p>

    <div class="row end gap">
      <button type="submit" class="primary" disabled={!dir.trim() || busy}>Get started</button>
    </div>
  </form>
</div>

<style>
  .hero {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .hero h2 {
    margin: 0;
  }
  .hero p {
    margin: 2px 0 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field > span {
    font-size: 12px;
    color: var(--fg-2);
  }
  .link.small {
    align-self: flex-start;
  }
</style>
