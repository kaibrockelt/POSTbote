<script>
  import TreeFolder from './TreeFolder.svelte';
  import { app, select, openWorkspace, reload, exportWorkspace, removeWorkspace, confirmAction, fail, toast } from '../lib/state.svelte.js';
  import { buildTree } from '../lib/tree.js';
  import { envName, isPublicEnv } from '../lib/format.js';
  import * as act from '../lib/actions.js';

  let { onNewWorkspace } = $props();
  let collapsed = $state({});
  let filter = $state('');

  const tree = $derived(buildTree(app.files));
  const visibleTree = $derived(filter ? filterTree(tree.root, filter.toLowerCase()) : tree.root);
  const sel = (kind, path) => app.selected?.kind === kind && app.selected?.path === path;

  function filterTree(f, q) {
    const folders = f.folders.map((x) => filterTree(x, q)).filter((x) => x.folders.length || x.requests.length);
    const requests = f.requests.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
    return { ...f, folders, requests };
  }

  async function switchWs(e) {
    const ws = app.workspaces.find((w) => w.id === e.currentTarget.value);
    if (ws) await openWorkspace(ws).catch(fail);
  }

  async function removeWs() {
    const ws = app.ws;
    const msg =
      ws.storage === 'disk'
        ? 'The folder on disk is kept; it is only removed from this list.'
        : ws.storage === 'browser'
          ? 'All files of this collection are deleted from this browser. Export it first if you want to keep it.'
          : 'All files of this collection are deleted from the server.';
    if (!(await confirmAction(`Remove “${ws.name}”?`, msg, ws.storage === 'disk' ? 'Remove' : 'Delete'))) return;
    await removeWorkspace(ws).catch(fail);
  }

  const storageLabel = { disk: 'external folder', browser: 'browser', server: 'server' };
</script>

<aside class="sidebar">
  <div class="ws-row">
    <select class="ws-select" value={app.ws?.id} onchange={switchWs}>
      {#each app.workspaces as w (w.id)}
        <option value={w.id}>{w.name || '(unnamed)'}{w.managed ? '' : ` · ${storageLabel[w.storage]}`}{w.error ? ' ⚠' : ''}</option>
      {/each}
    </select>
    <button class="icon" title="New / open / import collection" onclick={onNewWorkspace}>＋</button>
  </div>
  <div class="ws-tools">
    <button class="link" onclick={() => select({ kind: 'collection', path: 'postbote.yaml' })}>⚙ Settings</button>
    {#if app.ws.storage !== 'browser'}
      <button class="link" onclick={() => reload().then(() => toast('Reloaded')).catch(fail)} title="Re-read files, e.g. after git pull">⟳ Reload</button>
    {/if}
    {#if app.ws.storage !== 'disk'}<button class="link" onclick={() => exportWorkspace().catch(fail)}>⇩ Export</button>{/if}
    {#if !app.ws.managed}<button class="link danger" onclick={removeWs}>✕ Remove</button>{/if}
  </div>

  <div class="scroll">
    <div class="section">
      <div class="section-head">
        <span>Requests</span>
        <span class="actions">
          <button class="icon" title="New request" onclick={() => act.newRequest()}>＋</button>
          <button class="icon" title="New folder" onclick={() => act.newFolder()}>⊞</button>
        </span>
      </div>
      <input class="filter" placeholder="Filter…" bind:value={filter} />
      <TreeFolder folder={visibleTree} bind:collapsed />
      {#if !tree.root.requests.length && !tree.root.folders.length}<p class="hint pad">No requests yet.</p>{/if}
    </div>

    <div class="section">
      <div class="section-head">
        <span>Workflows</span>
        <span class="actions"><button class="icon" title="New workflow" onclick={act.newWorkflow}>＋</button></span>
      </div>
      {#each tree.workflows as w (w.path)}
        <div class="item" class:selected={sel('workflow', w.path)}>
          <button class="label" onclick={() => select({ kind: 'workflow', path: w.path })}>
            ⇶ {w.name}
            {#if app.running[w.path]}<span class="spinner"></span>{/if}
          </button>
          <span class="actions">
            <button class="icon" title="Rename" onclick={() => act.renameWorkflow(w.path)}>✎</button>
            <button class="icon" title="Delete" onclick={() => act.deleteFile(w.path, w.name)}>🗑</button>
          </span>
        </div>
      {/each}
    </div>

    <div class="section">
      <div class="section-head">
        <span>Environments</span>
        <span class="actions"><button class="icon" title="New environment" onclick={act.newEnv}>＋</button></span>
      </div>
      {#each tree.envs as e (e)}
        <div class="item" class:selected={sel('env', e)}>
          <button class="label" onclick={() => select({ kind: 'env', path: e })}>
            <span class="dot" class:active={app.env === e}></span>
            {envName(e)}
            <span class="tag" title={isPublicEnv(e) ? 'committed to git' : 'gitignored'}>{isPublicEnv(e) ? 'pub' : 'private'}</span>
          </button>
          <span class="actions">
            <button class="icon" title="Rename" onclick={() => act.renameEnv(e)}>✎</button>
            <button class="icon" title="Delete" onclick={() => act.deleteFile(e)}>🗑</button>
          </span>
        </div>
      {/each}
    </div>

  </div>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg-1);
    min-height: 0;
  }
  .ws-row {
    display: flex;
    gap: 4px;
    padding: 10px 10px 4px;
  }
  .ws-select {
    flex: 1;
    min-width: 0;
    font-weight: 600;
  }
  .ws-tools {
    display: flex;
    gap: 10px;
    padding: 0 12px 8px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    font-size: 12px;
  }
  .scroll {
    overflow: auto;
    flex: 1;
    padding-bottom: 20px;
  }
  .section {
    padding: 6px 4px;
  }
  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-3);
    font-weight: 600;
  }
  .filter {
    margin: 2px 6px 6px;
    width: calc(100% - 12px);
    padding: 4px 8px;
    font-size: 12px;
  }
  .pad {
    padding: 0 10px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid var(--fg-3);
    display: inline-block;
  }
  .dot.active {
    background: var(--ok);
    border-color: var(--ok);
  }
  .tag {
    font-size: 10px;
    color: var(--fg-3);
    margin-left: auto;
  }
</style>
