<script>
  import FolderPlusIcon from './FolderPlusIcon.svelte';
  import Icon from './Icon.svelte';
  import TreeFolder from './TreeFolder.svelte';
  import { app, select, isDirty, setEnv, openMenu, openWorkspace, reload, removeWorkspace, confirmAction, askRemove, toggleCollapsed, contentOf, fail, toast } from '../lib/state.svelte.js';
  import { buildTree, filterTree, folderList } from '../lib/tree.js';
  import { dnd, dragOver, dragLeave, drop } from '../lib/dnd.svelte.js';
  import { envPublicPath, envPrivatePath, parseEnv } from '../lib/format.js';
  import * as act from '../lib/actions.js';

  let { onNewWorkspace } = $props();
  let filter = $state('');

  const tree = $derived(buildTree(app.files));
  const filtering = $derived(filter.trim() !== '');
  const visibleTree = $derived(filtering ? filterTree(tree.root, filter) : tree.root);
  const folders = $derived(folderList(tree.root));
  const sel = (kind, path) => app.selected?.kind === kind && app.selected?.path === path;
  // sections fold away their items; filtering always shows the requests
  const open = (name) => !app.collapsed[`section:${name}`] || (name === 'requests' && filtering);
  // which parts of an environment define variables (`token=` counts, a file with only comments does not)
  const hasValues = (path) => parseEnv(contentOf(path)).length > 0;
  const envTag = (name) => [hasValues(envPublicPath(name)) && 'shared', hasValues(envPrivatePath(name)) && 'private'].filter(Boolean).join(' + ') || 'empty';
  const countRequests = (f) => f.requests.length + f.folders.reduce((n, sub) => n + countRequests(sub), 0);

  async function switchWs(e) {
    const ws = app.workspaces.find((w) => w.id === e.currentTarget.value);
    if (ws) await openWorkspace(ws).catch(fail);
  }

  // external folders can leave the list while staying on disk
  async function unlistWs() {
    const ws = app.ws;
    if (!(await confirmAction(`Remove “${ws.name}” from the list?`, `The folder ${ws.path} stays on disk.`, 'Remove'))) return;
    await removeWorkspace(ws, 'unlist').catch(fail);
  }

  async function deleteWs() {
    const ws = app.ws;
    const msg =
      ws.storage === 'disk'
        ? `The folder ${ws.path} with all requests, environments and data files. “Move to trash” keeps it restorable.`
        : ws.storage === 'browser'
          ? 'All files of this collection are deleted from this browser. Export it first if you want to keep it.'
          : 'All files of this collection are deleted from the server.';
    const mode = await askRemove(`Remove collection “${ws.name}”?`, msg);
    if (!mode) return;
    await removeWorkspace(ws, mode)
      .then(() => toast(mode === 'trash' ? `Moved “${ws.name}” to the trash` : `Deleted “${ws.name}”`))
      .catch(fail);
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
    {#if app.ws.storage === 'disk' && !app.ws.managed}<button class="icon danger" title="Remove from list (the folder stays)" aria-label="Remove from list" onclick={unlistWs}><Icon name="remove" /></button>{/if}
    <button class="icon danger" title="Delete or move collection to trash" aria-label="Delete collection" onclick={deleteWs}><Icon name="trash" /></button>
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
        <button class="head-toggle" aria-expanded={open('requests')} onclick={() => toggleCollapsed('section:requests')}>
          <span class="caret">{open('requests') ? '▾' : '▸'}</span>Requests
          {#if !open('requests')}<span class="count">{countRequests(tree.root)}</span>{/if}
        </button>
        <span class="actions">
          <button class="icon" title="New request" onclick={() => act.newRequest()}>＋</button>
          <button class="icon" title="New folder" onclick={() => act.newFolder()}><FolderPlusIcon /></button>
        </span>
      </div>
      {#if open('requests')}
        <input class="filter" placeholder="Filter: name, method, URL…" bind:value={filter} onkeydown={(e) => e.key === 'Escape' && (filter = '')} />
        <TreeFolder folder={visibleTree} {folders} forceOpen={filtering} />
        {#if filtering && !visibleTree.requests.length && !visibleTree.folders.length}<p class="hint pad">No request matches “{filter}”.</p>{/if}
        {#if !tree.root.requests.length && !tree.root.folders.length}<p class="hint pad">No requests yet.</p>{/if}
      {/if}
    </div>

    <div class="section">
      <div class="section-head">
        <button class="head-toggle" aria-expanded={open('runners')} onclick={() => toggleCollapsed('section:runners')}>
          <span class="caret">{open('runners') ? '▾' : '▸'}</span>Runners
          {#if !open('runners')}<span class="count">{tree.workflows.length}</span>{/if}
        </button>
        <span class="actions"><button class="icon" title="New runner" onclick={act.newWorkflow}>＋</button></span>
      </div>
      {#each open('runners') ? tree.workflows : [] as w (w.path)}
        <div class="item" class:selected={sel('workflow', w.path)} role="treeitem" aria-selected={sel('workflow', w.path)} tabindex="-1"
          oncontextmenu={(ev) => openMenu(ev, [
            { label: 'Open', action: () => select({ kind: 'workflow', path: w.path }) },
            { label: 'Rename…', action: () => act.renameWorkflow(w.path) },
            { separator: true },
            ...act.removeItems((mode) => act.deleteFile(w.path, w.name, mode)),
          ])}>
          <button class="label" onclick={() => select({ kind: 'workflow', path: w.path })}>
            ⇶ {w.name}
            {#if isDirty(w.path)}<span class="unsaved" title="unsaved changes">●</span>{/if}
            {#if app.running[w.path]}<span class="spinner"></span>{/if}
          </button>
          <span class="actions">
            <button class="icon" title="Rename" onclick={() => act.renameWorkflow(w.path)}>✎</button>
            <button class="icon" title="Delete or move to trash" onclick={() => act.deleteFile(w.path, w.name)}><Icon name="trash" size={13} /></button>
          </span>
        </div>
      {/each}
    </div>

    <div class="section">
      <div class="section-head">
        <button class="head-toggle" aria-expanded={open('graphs')} onclick={() => toggleCollapsed('section:graphs')}>
          <span class="caret">{open('graphs') ? '▾' : '▸'}</span>Workflows
          {#if !open('graphs')}<span class="count">{tree.graphs.length}</span>{/if}
        </button>
        <span class="actions"><button class="icon" title="New workflow" onclick={act.newGraph}>＋</button></span>
      </div>
      {#each open('graphs') ? tree.graphs : [] as g (g.path)}
        <div class="item" class:selected={sel('graph', g.path)} role="treeitem" aria-selected={sel('graph', g.path)} tabindex="-1"
          oncontextmenu={(ev) => openMenu(ev, [
            { label: 'Open', action: () => select({ kind: 'graph', path: g.path }) },
            { label: 'Rename…', action: () => act.renameGraph(g.path) },
            { separator: true },
            ...act.removeItems((mode) => act.deleteFile(g.path, g.name, mode)),
          ])}>
          <button class="label" onclick={() => select({ kind: 'graph', path: g.path })}>
            ◇ {g.name}
            {#if isDirty(g.path)}<span class="unsaved" title="unsaved changes">●</span>{/if}
            {#if app.running[g.path]}<span class="spinner"></span>{/if}
          </button>
          <span class="actions">
            <button class="icon" title="Rename" onclick={() => act.renameGraph(g.path)}>✎</button>
            <button class="icon" title="Delete or move to trash" onclick={() => act.deleteFile(g.path, g.name)}><Icon name="trash" size={13} /></button>
          </span>
        </div>
      {/each}
    </div>

    <div class="section">
      <div class="section-head">
        <button class="head-toggle" aria-expanded={open('envs')} onclick={() => toggleCollapsed('section:envs')}>
          <span class="caret">{open('envs') ? '▾' : '▸'}</span>Environments
          {#if !open('envs')}<span class="count">{tree.envs.length}</span>{/if}
        </button>
        <span class="actions"><button class="icon" title="New environment" onclick={act.newEnv}>＋</button></span>
      </div>
      {#each open('envs') ? tree.envs : [] as e (e.name)}
        <div class="item" class:selected={sel('env', e.name)} role="treeitem" aria-selected={sel('env', e.name)} tabindex="-1"
          oncontextmenu={(ev) => openMenu(ev, [
            { label: app.env === e.name ? 'Deactivate' : 'Activate', action: () => setEnv(app.env === e.name ? '' : e.name) },
            { label: 'Rename…', action: () => act.renameEnv(e.name) },
            { separator: true },
            ...act.removeItems((mode) => act.deleteEnv(e.name, mode)),
          ])}>
          <button class="label" onclick={() => select({ kind: 'env', path: e.name })}>
            <span class="dot" class:active={app.env === e.name}></span>
            {e.name}
            {#if isDirty(envPublicPath(e.name)) || isDirty(envPrivatePath(e.name))}<span class="unsaved" title="unsaved changes">●</span>{/if}
            <span class="tag" title="defines shared variables (committed) / private variables (gitignored)">{envTag(e.name)}</span>
          </button>
          <span class="actions">
            <button class="icon" title="Rename" onclick={() => act.renameEnv(e.name)}>✎</button>
            <button class="icon" title="Delete or move to trash" onclick={() => act.deleteEnv(e.name)}><Icon name="trash" size={13} /></button>
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
  .head-toggle {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    font: inherit;
    letter-spacing: inherit;
    color: inherit;
  }
  .head-toggle:hover {
    color: var(--fg-2);
  }
  .head-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 3px;
  }
  /* same size as the folder twisties below */
  .caret {
    width: 14px;
    font-size: 13px;
    line-height: 1;
    text-align: center;
  }
  .count {
    font-weight: normal;
    letter-spacing: 0;
    text-transform: none;
    background: var(--bg-3);
    border-radius: 8px;
    padding: 0 6px;
    margin-left: 2px;
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
