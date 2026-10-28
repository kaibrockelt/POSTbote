<script>
  import Sidebar from './components/Sidebar.svelte';
  import RequestEditor from './components/RequestEditor.svelte';
  import WorkflowEditor from './components/WorkflowEditor.svelte';
  import GraphEditor from './components/GraphEditor.svelte';
  import EnvEditor from './components/EnvEditor.svelte';
  import CollectionEditor from './components/CollectionEditor.svelte';
  import FolderEditor from './components/FolderEditor.svelte';
  import FileEditor from './components/FileEditor.svelte';
  import WorkspaceDialog from './components/WorkspaceDialog.svelte';
  import Dialog from './components/Dialog.svelte';
  import Login from './components/Login.svelte';
  import Setup from './components/Setup.svelte';
  import Settings from './components/Settings.svelte';
  import Icon from './components/Icon.svelte';
  import FolderPicker from './components/FolderPicker.svelte';
  import TabBar from './components/TabBar.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import ExportDialog from './components/ExportDialog.svelte';
  import { app, init, setEnv, reload, flush, flushSession, saveTab, closeTab, run, cancelRun, contentOf, fail, toast } from './lib/state.svelte.js';
  import { api } from './lib/api.js';
  import { buildTree } from './lib/tree.js';
  import { listEnvs, getEnvTint, envPublicPath, envPrivatePath } from './lib/format.js';

  let showWsDialog = $state(false);
  let showSettings = $state(false);
  let ready = $state(false);
  let startError = $state('');

  init()
    .catch((e) => (startError = e.message))
    .finally(() => (ready = true));

  const envs = $derived(listEnvs(app.files));
  const sel = $derived(app.selected);

  // tint the window while the active environment has one (private file wins)
  const tint = $derived(app.ws && app.env ? getEnvTint(contentOf(envPrivatePath(app.env))) || getEnvTint(contentOf(envPublicPath(app.env))) : '');
  $effect(() => {
    const root = document.documentElement;
    if (tint) {
      root.dataset.tint = '';
      root.style.setProperty('--tint', tint);
    } else {
      delete root.dataset.tint;
      root.style.removeProperty('--tint');
    }
  });

  // pick up external edits (git pull, editor) when the window regains focus
  function onfocus() {
    if (app.ws && app.ws.storage !== 'browser' && !app.dialog) reload().catch(() => {});
  }
  function onbeforeunload(e) {
    // unsaved drafts live in the session, so closing never loses them
    flushSession();
    if (app.saving) {
      flush();
      e.preventDefault();
    }
  }
  // Cmd on macOS, Ctrl elsewhere (both accepted everywhere)
  function onkeydown(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || app.dialog) return;
    const t = app.selected;
    switch (e.key.toLowerCase()) {
      case 's': // save the open tab
        e.preventDefault();
        if (t) saveTab(t).catch(fail);
        break;
      case 'w': // close the open tab (the desktop app keeps the window open)
        e.preventDefault();
        if (t) closeTab(t).catch(fail);
        break;
      case 'r': // re-read the collection from disk
        e.preventDefault();
        if (app.ws && app.ws.storage !== 'browser') reload().then(() => toast('Reloaded')).catch(fail);
        break;
      case 'enter': // run (or cancel) whatever the open tab can run
        if (t?.kind !== 'request' && t?.kind !== 'workflow' && t?.kind !== 'graph') break;
        e.preventDefault();
        if (app.running[t.path]) cancelRun(t.path);
        else run(t.kind, t.path);
        break;
    }
  }
  async function logout() {
    await api.logout().catch(fail);
    location.reload();
  }
</script>

<svelte:window {onfocus} {onbeforeunload} {onkeydown} />

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
      <div class="brand"><img src="/favicon.svg" alt="" width="30" height="30" /> POSTBote</div>
      <div class="grow"></div>
      <span class="muted small saving">{app.saving ? 'Saving…' : ''}</span>
      {#if app.ws}
        <label class="env-select">
          <span class="muted">Environment</span>
          <select value={app.env} onchange={(e) => setEnv(e.currentTarget.value)}>
            <option value="">— none —</option>
            {#each envs as e (e.name)}<option value={e.name}>{e.name}</option>{/each}
          </select>
        </label>
      {/if}
      {#if app.info.mode === 'server'}
        <span class="muted small">{app.info.user}</span>
        {#if app.info.auth === 'local'}<button class="link small" onclick={logout}>Sign out</button>{/if}
      {/if}
      <button class="icon gear" title="Settings" aria-label="Settings" onclick={() => (showSettings = true)}><Icon name="gear" size={16} /></button>
    </header>

    {#if app.ws}
      <Sidebar onNewWorkspace={() => (showWsDialog = true)} />
      <div class="workarea">
      <TabBar />
      <main class="main">
        {#if app.loading}
          <p class="muted">Loading…</p>
        {:else if !sel}
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
            {:else if sel.kind === 'graph'}<GraphEditor path={sel.path} />
            {:else if sel.kind === 'env'}<EnvEditor path={sel.path} />
            {:else if sel.kind === 'collection'}<CollectionEditor />
            {:else if sel.kind === 'folder'}<FolderEditor path={sel.path} />
            {:else}<FileEditor path={sel.path} />{/if}
          {/key}
        {/if}
      </main>
      </div>
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
{:else if showSettings}
  <Settings onclose={() => (showSettings = false)} />
{/if}
{#if showWsDialog}
  <WorkspaceDialog onclose={() => (showWsDialog = false)} />
{/if}
{#if app.exporting && app.ws}
  <ExportDialog onclose={() => (app.exporting = false)} />
{/if}
{#if app.picker}
  <FolderPicker start={app.picker.start} onpick={(p) => app.picker.resolve(p)} oncancel={() => app.picker.resolve(null)} />
{/if}
<Dialog />
<ContextMenu />
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
  :global(:root[data-tint]) .topbar {
    box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--tint) 80%, transparent);
  }
  .env-select {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .saving {
    min-width: 60px;
    text-align: right;
  }
  .gear {
    display: inline-flex;
    margin-right: -6px;
  }
  .workarea {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .main {
    overflow: auto;
    padding: 16px 20px;
    min-height: 0;
    flex: 1;
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
