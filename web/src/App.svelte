<script>
  import Sidebar from './components/Sidebar.svelte';
  import RequestEditor from './components/RequestEditor.svelte';
  import WorkflowEditor from './components/WorkflowEditor.svelte';
  import EnvEditor from './components/EnvEditor.svelte';
  import CollectionEditor from './components/CollectionEditor.svelte';
  import FolderEditor from './components/FolderEditor.svelte';
  import FileEditor from './components/FileEditor.svelte';
  import WorkspaceDialog from './components/WorkspaceDialog.svelte';
  import Dialog from './components/Dialog.svelte';
  import Login from './components/Login.svelte';
  import Setup from './components/Setup.svelte';
  import FolderPicker from './components/FolderPicker.svelte';
  import { app, init, setEnv, reload, flush, fail } from './lib/state.svelte.js';
  import { api } from './lib/api.js';
  import { buildTree } from './lib/tree.js';
  import { envName, isPublicEnv } from './lib/format.js';

  let showWsDialog = $state(false);
  let showFolderSettings = $state(false);
  let ready = $state(false);
  let startError = $state('');

  init()
    .catch((e) => (startError = e.message))
    .finally(() => (ready = true));

  const envs = $derived(buildTree(app.files).envs);
  const sel = $derived(app.selected);
  const exists = $derived(sel && (sel.kind === 'folder' || sel.path in app.files || sel.kind === 'collection'));

  // pick up external edits (git pull, editor) when the window regains focus
  function onfocus() {
    if (app.ws && app.ws.storage !== 'browser' && !app.dialog) reload().catch(() => {});
  }
  function onbeforeunload(e) {
    if (app.saving) {
      flush();
      e.preventDefault();
    }
  }
  async function logout() {
    await api.logout().catch(fail);
    location.reload();
  }
</script>

<svelte:window {onfocus} {onbeforeunload} />

{#if !ready}
  <div class="splash muted">Loading…</div>
{:else if startError}
  <div class="splash"><div class="error-box">Cannot reach the POSTBote server: {startError}</div></div>
{:else if !app.info?.authenticated}
  {#if app.info?.auth === 'local'}
    <Login />
  {:else if app.info?.mode === 'local'}
    <div class="splash"><div class="error-box">Session expired. Restart POSTBote to get a new access link.</div></div>
  {:else}
    <div class="splash"><div class="error-box">Not authenticated. This instance expects a login via your identity proxy.</div></div>
  {/if}
{:else}
  <div class="layout">
    <header class="topbar">
      <div class="brand"><img src="/favicon.svg" alt="" width="20" height="20" /> POSTBote</div>
      <div class="grow"></div>
      {#if app.ws}
        <label class="env-select">
          <span class="muted">Environment</span>
          <select value={app.env} onchange={(e) => setEnv(e.currentTarget.value)}>
            <option value="">— none —</option>
            {#each envs as e}<option value={e}>{envName(e)}{isPublicEnv(e) ? ' (public)' : ''}</option>{/each}
          </select>
        </label>
      {/if}
      <span class="muted small saving">{app.saving ? 'Saving…' : ''}</span>
      {#if app.info.mode === 'local' && app.info.setup?.collectionsDir}
        <button class="link small" title={app.info.setup.collectionsDir} onclick={() => (showFolderSettings = true)}>📁 Collections folder</button>
      {/if}
      {#if app.info.mode === 'server'}
        <span class="muted small">{app.info.user}</span>
        {#if app.info.auth === 'local'}<button class="link small" onclick={logout}>Sign out</button>{/if}
      {/if}
    </header>

    {#if app.ws}
      <Sidebar onNewWorkspace={() => (showWsDialog = true)} />
      <main class="main">
        {#if app.loading}
          <p class="muted">Loading…</p>
        {:else if !sel || !exists}
          <div class="welcome">
            <h2>{app.ws.name}</h2>
            <p class="muted">
              {#if app.ws.storage === 'disk'}Folder <code class="mono">{app.ws.path}</code>
              {:else if app.ws.storage === 'browser'}Stored in this browser
              {:else}Stored on the server (private){/if}
            </p>
            <p>Select a request on the left, or create one. <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> sends the open request.</p>
          </div>
        {:else}
          {#key `${sel.kind}:${sel.path}`}
            {#if sel.kind === 'request'}<RequestEditor path={sel.path} />
            {:else if sel.kind === 'workflow'}<WorkflowEditor path={sel.path} />
            {:else if sel.kind === 'env'}<EnvEditor path={sel.path} />
            {:else if sel.kind === 'collection'}<CollectionEditor />
            {:else if sel.kind === 'folder'}<FolderEditor path={sel.path} />
            {:else}<FileEditor path={sel.path} />{/if}
          {/key}
        {/if}
      </main>
    {:else}
      <main class="main full">
        <div class="welcome">
          <h2>Welcome to POSTBote</h2>
          <p>Your API collections are plain text files – versionable, offline, no cloud.</p>
          {#if app.info.mode === 'local' && app.info.setup?.collectionsDir}
            <p class="muted">Collections folder: <code class="mono">{app.info.setup.collectionsDir}</code></p>
          {/if}
          <button class="primary" onclick={() => (showWsDialog = true)}>Add a collection</button>
        </div>
      </main>
    {/if}
  </div>
{/if}

{#if ready && app.info?.authenticated && app.info.setup?.needed}
  <Setup />
{:else if showFolderSettings}
  <Setup mode="settings" onclose={() => (showFolderSettings = false)} />
{/if}
{#if showWsDialog}
  <WorkspaceDialog onclose={() => (showWsDialog = false)} />
{/if}
{#if app.picker}
  <FolderPicker start={app.picker.start} onpick={(p) => app.picker.resolve(p)} oncancel={() => app.picker.resolve(null)} />
{/if}
<Dialog />
<div class="toasts">
  {#each app.toasts as t (t.id)}<div class="toast {t.kind}">{t.message}</div>{/each}
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 290px minmax(0, 1fr);
    grid-template-rows: 44px minmax(0, 1fr);
    height: 100vh;
  }
  .topbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-1);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .env-select {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .saving {
    width: 60px;
  }
  .main {
    overflow: auto;
    padding: 16px 20px;
    min-height: 0;
  }
  .main.full {
    grid-column: 1 / -1;
  }
  .welcome {
    max-width: 560px;
    margin: 10vh auto;
    text-align: center;
  }
  .splash {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  @media (max-width: 760px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 44px auto minmax(0, 1fr);
      height: auto;
      min-height: 100vh;
    }
    .env-select .muted {
      display: none;
    }
  }
</style>
