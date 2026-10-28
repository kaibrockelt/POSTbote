<script>
  import FolderPlusIcon from './FolderPlusIcon.svelte';
  import Icon from './Icon.svelte';
  import TreeFolder from './TreeFolder.svelte';
  import { app, select, isDirty, setEnv, openMenu, openWorkspace, reload, removeWorkspace, confirmAction, fail, toast } from '../lib/state.svelte.js';
  import { buildTree, filterTree, folderList } from '../lib/tree.js';
  import { dnd, dragOver, dragLeave, drop } from '../lib/dnd.svelte.js';
  import { envPublicPath, envPrivatePath } from '../lib/format.js';
  import * as act from '../lib/actions.js';

  let { onNewWorkspace } = $props();
  let collapsed = $state({});
  let filter = $state('');

  const tree = $derived(buildTree(app.files));
  const filtering = $derived(filter.trim() !== '');
  const visibleTree = $derived(filtering ? filterTree(tree.root, filter) : tree.root);
  const folders = $derived(folderList(tree.root));
  const sel = (kind, path) => app.selected?.kind === kind && app.selected?.path === path;

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
  <div class="ws-box">
    <select class="ws-select" value={app.ws?.id} onchange={switchWs} title="Collection">
      {#each app.workspaces as w (w.id)}
        <option value={w.id}>{w.name || '(unnamed)'}{w.managed ? '' : ` · ${storageLabel[w.storage]}`}{w.error ? ' ⚠' : ''}</option>
      {/each}
    </select>
    <button class="icon" title="Collection settings" aria-label="Collection settings" onclick={() => select({ kind: 'collection', path: 'postbote.yaml' })}><Icon name="gear" /></button>
    {#if app.ws.storage !== 'browser'}
      <button class="icon" title="Reload from disk, e.g. after git pull (⌘/Ctrl+R)" aria-label="Reload" onclick={() => reload().then(() => toast('Reloaded')).catch(fail)}><Icon name="reload" /></button>
    {/if}
    <button class="icon" title="Export as zip" aria-label="Export" onclick={() => (app.exporting = true)}><Icon name="export" /></button>
    {#if !app.ws.managed}<button class="icon danger" title="Remove from list" aria-label="Remove" onclick={removeWs}><Icon name="remove" /></button>{/if}
    <button class="icon" title="New / open / import collection" aria-label="New collection" onclick={onNewWorkspace}>＋</button>
  </div>

  <div class="scroll">
    <!-- dropping anywhere in this section (outside a folder) moves to the top level -->
    <div
      class="section"
      class:drop-target={dnd.target === tree.root.path}
      role="tree"
      tabindex="-1"
      ondragover={(e) => dragOver(e, tree.root.path)}
      ondragleave={(e) => dragLeave(e, tree.root.path)}
      ondrop={(e) => drop(e, tree.root.path)}
    >
      <div class="section-head">
        <span>Requests</span>
        <span class="actions">
          <button class="icon" title="New request" onclick={() => act.newRequest()}>＋</button>
          <button class="icon" title="New folder" onclick={() => act.newFolder()}><FolderPlusIcon /></button>
        </span>
      </div>
      <input class="filter" placeholder="Filter: name, method, URL…" bind:value={filter} onkeydown={(e) => e.key === 'Escape' && (filter = '')} />
      <TreeFolder folder={visibleTree} bind:collapsed {folders} forceOpen={filtering} />
      {#if filtering && !visibleTree.requests.length && !visibleTree.folders.length}<p class="hint pad">No request matches “{filter}”.</p>{/if}
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
            {#if isDirty(w.path)}<span class="unsaved" title="unsaved changes">●</span>{/if}
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
      {#each tree.envs as e (e.name)}
        <div class="item" class:selected={sel('env', e.name)} role="treeitem" aria-selected={sel('env', e.name)} tabindex="-1"
          oncontextmenu={(ev) => openMenu(ev, [
            { label: app.env === e.name ? 'Deactivate' : 'Activate', action: () => setEnv(app.env === e.name ? '' : e.name) },
            { label: 'Rename…', action: () => act.renameEnv(e.name) },
            { separator: true },
            { label: 'Delete', danger: true, action: () => act.deleteEnv(e.name) },
          ])}>
          <button class="label" onclick={() => select({ kind: 'env', path: e.name })}>
            <span class="dot" class:active={app.env === e.name}></span>
            {e.name}
            {#if isDirty(envPublicPath(e.name)) || isDirty(envPrivatePath(e.name))}<span class="unsaved" title="unsaved changes">●</span>{/if}
            <span class="tag" title="shared values (committed) / private overrides (gitignored)">{[e.pub && 'shared', e.priv && 'private'].filter(Boolean).join(' + ')}</span>
          </button>
          <span class="actions">
            <button class="icon" title="Rename" onclick={() => act.renameEnv(e.name)}>✎</button>
            <button class="icon" title="Delete" onclick={() => act.deleteEnv(e.name)}>🗑</button>
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
  .ws-box {
    display: flex;
    align-items: center;
    gap: 2px;
    margin: 8px 8px 4px;
    padding: 5px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-2);
  }
  .ws-select {
    flex: 1;
    min-width: 0;
    margin-right: 2px;
    font-weight: 600;
  }
  .ws-box .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ws-box .danger:hover {
    color: var(--bad);
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
