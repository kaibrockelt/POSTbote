<script>
  import FolderPlusIcon from './FolderPlusIcon.svelte';
  import Icon from './Icon.svelte';
  import TreeFolder from './TreeFolder.svelte';
  import { app, select, isDirty, openMenu } from '../lib/state.svelte.js';
  import {
    newRequest,
    newFolder,
    renameRequest,
    duplicateRequest,
    moveFolder,
    deleteFolder,
    deleteFile,
    moveRequest,
    moveFolderInto,
    removeItems,
  } from '../lib/actions.js';
  import { dnd, dragStart, dragEnd, dragOver, dragLeave, drop } from '../lib/dnd.svelte.js';

  // folders: all request folders ({ path, label }) for "Move to"; forceOpen while filtering
  let { folder, depth = 0, collapsed = $bindable({}), folders = [], forceOpen = false } = $props();
  const isOpen = $derived(forceOpen || !collapsed[folder.path]);
  const sel = (kind, path) => app.selected?.kind === kind && app.selected?.path === path;
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const short = (m) => (m === 'DELETE' ? 'DEL' : m === 'OPTIONS' ? 'OPT' : m);

  function requestMenu(e, r) {
    openMenu(e, [
      { label: 'Open', action: () => select({ kind: 'request', path: r.path }) },
      { label: 'Rename…', action: () => renameRequest(r.path) },
      { label: 'Duplicate', action: () => duplicateRequest(r.path) },
      {
        label: 'Move to',
        items: folders.map((f) => ({ label: f.label, disabled: f.path === parentOf(r.path), hint: 'current', action: () => moveRequest(r.path, f.path) })),
      },
      { separator: true },
      ...removeItems((mode) => deleteFile(r.path, r.name, mode)),
    ]);
  }

  function folderMenu(e, f) {
    openMenu(e, [
      { label: 'Settings', action: () => select({ kind: 'folder', path: f.path }) },
      { label: 'New request…', action: () => newRequest(f.path) },
      { label: 'New subfolder…', action: () => newFolder(f.path) },
      { label: 'Rename…', action: () => moveFolder(f.path) },
      {
        label: 'Move to',
        items: folders.map((t) => ({
          label: t.label,
          disabled: t.path === parentOf(f.path) || t.path === f.path || t.path.startsWith(f.path + '/'),
          hint: t.path === parentOf(f.path) ? 'current' : '',
          action: () => moveFolderInto(f.path, t.path),
        })),
      },
      { separator: true },
      ...removeItems((mode) => deleteFolder(f.path, mode)),
    ]);
  }
</script>

{#if depth > 0}
  <div
    class="item folder"
    class:selected={sel('folder', folder.path)}
    class:drop-target={dnd.target === folder.path}
    class:dragging={dnd.item?.path === folder.path}
    style="padding-left: {depth * 12}px"
    role="treeitem"
    aria-selected={sel('folder', folder.path)}
    aria-expanded={isOpen}
    tabindex="-1"
    draggable="true"
    ondragstart={(e) => dragStart(e, { kind: 'folder', path: folder.path })}
    ondragend={dragEnd}
    ondragover={(e) => dragOver(e, folder.path)}
    ondragleave={(e) => dragLeave(e, folder.path)}
    ondrop={(e) => drop(e, folder.path)}
    oncontextmenu={(e) => folderMenu(e, folder)}
  >
    <button class="twisty" onclick={() => (collapsed[folder.path] = isOpen)} aria-label="toggle">{isOpen ? '▾' : '▸'}</button>
    <button class="label" onclick={() => select({ kind: 'folder', path: folder.path })}>📁 {folder.label || folder.name}</button>
    <span class="actions">
      <button class="icon" title="New request" onclick={() => newRequest(folder.path)}>＋</button>
      <button class="icon" title="New subfolder" onclick={() => newFolder(folder.path)}><FolderPlusIcon /></button>
      <button class="icon" title="Rename" onclick={() => moveFolder(folder.path)}>✎</button>
      <button class="icon" title="Delete or move to trash" onclick={() => deleteFolder(folder.path)}><Icon name="trash" size={13} /></button>
    </span>
  </div>
{/if}
{#if isOpen}
  {#each folder.folders as f (f.path)}
    <TreeFolder folder={f} depth={depth + 1} bind:collapsed {folders} {forceOpen} />
  {/each}
  {#each folder.requests as r (r.path)}
    <div
      class="item"
      class:selected={sel('request', r.path)}
      class:dragging={dnd.item?.path === r.path}
      style="padding-left: {(depth + 1) * 12 + 4}px"
      role="treeitem"
      aria-selected={sel('request', r.path)}
      tabindex="-1"
      draggable="true"
      ondragstart={(e) => dragStart(e, { kind: 'request', path: r.path })}
      ondragend={dragEnd}
      ondragover={(e) => dragOver(e, folder.path)}
      ondrop={(e) => drop(e, folder.path)}
      oncontextmenu={(e) => requestMenu(e, r)}
    >
      <button class="label" onclick={() => select({ kind: 'request', path: r.path })} title={r.path}>
        <span class="method m-{r.method}">{short(r.method)}</span>
        {r.name}
        {#if isDirty(r.path)}<span class="unsaved" title="unsaved changes">●</span>{/if}
        {#if app.running[r.path]}<span class="spinner"></span>{/if}
      </button>
      <span class="actions">
        <button class="icon" title="Rename" onclick={() => renameRequest(r.path)}>✎</button>
        <button class="icon" title="Duplicate" onclick={() => duplicateRequest(r.path)}>⧉</button>
        <button class="icon" title="Delete or move to trash" onclick={() => deleteFile(r.path, r.name)}><Icon name="trash" size={13} /></button>
      </span>
    </div>
  {/each}
{/if}
