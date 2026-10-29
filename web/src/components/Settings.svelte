<script>
  // App-wide settings (gear in the top bar). Sections are added here as
  // global settings appear; collection settings stay in postbote.yaml.
  import { app, setCollectionsDir, pickFolder, fail, toast } from '../lib/state.svelte.js';
  import { api } from '../lib/api.js';

  let { onclose } = $props();
  const setup = app.info.setup;
  const local = app.info.mode === 'local' && !!setup?.collectionsDir;
  const initialDir = setup?.collectionsDir || '';
  let dir = $state(initialDir);
  let busy = $state(false);
  const changed = $derived(dir.trim() !== initialDir);

  // team server: the signed-in user; passwords only with --auth local
  const server = app.info.mode === 'server';
  const ownPassword = server && app.info.auth === 'local';
  let current = $state('');
  let next = $state('');
  let repeat = $state('');
  let pwBusy = $state(false);
  const pwError = $derived(next && next.length < 8 ? 'At least 8 characters' : repeat && repeat !== next ? 'Passwords do not match' : '');

  async function changePassword() {
    pwBusy = true;
    try {
      await api.changePassword(current, next);
      current = next = repeat = '';
      toast('Password changed. Other sessions are signed out.');
    } catch (err) {
      fail(err);
    } finally {
      pwBusy = false;
    }
  }

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

    {#if server}
      <section>
        <h4>Account</h4>
        <p class="muted">Signed in as <strong>{app.info.user}</strong>{app.info.auth === 'header' ? ' (via your sign-in proxy)' : ''}</p>
        {#if ownPassword}
          <div class="pw">
            <input type="password" bind:value={current} placeholder="Current password" autocomplete="current-password" aria-label="Current password" />
            <input type="password" bind:value={next} placeholder="New password" autocomplete="new-password" aria-label="New password" />
            <input type="password" bind:value={repeat} placeholder="Repeat new password" autocomplete="new-password" aria-label="Repeat new password" />
            <button type="button" onclick={changePassword} disabled={pwBusy || !current || !next || next !== repeat || !!pwError}>Change password</button>
          </div>
          {#if pwError}<p class="hint warn">{pwError}</p>{/if}
          <p class="hint">Changing the password signs out your other sessions.</p>
        {/if}
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
  .pw {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr auto;
    gap: 6px;
  }
  @media (max-width: 640px) {
    .pw {
      grid-template-columns: 1fr;
    }
  }
  .hint.warn {
    color: var(--warn);
  }
</style>
