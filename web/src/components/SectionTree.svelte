<script>
  // Folder tree of runners or workflows: open, rename, move (drag & drop or
  // "Move to"), delete; folders like in the request tree.
  import FolderPlusIcon from './FolderPlusIcon.svelte';
  import Icon from './Icon.svelte';
  import SectionTree from './SectionTree.svelte';
  import { app, select, isDirty, openMenu, toggleCollapsed } from '../lib/state.svelte.js';
  import { newFolder, moveFolder, deleteFolder, deleteFile, moveFile, moveFolderInto, removeItems } from '../lib/actions.js';
  import { dnd, dragStart, dragEnd, dragOver, dragLeave, drop } from '../lib/dnd.svelte.js';

  // kind: tab kind of the items ('workflow' = runner, 'graph' = workflow)
  let { folder, depth = 0, kind, icon, onNew, onRename, folders = [] } = $props();
  const isOpen = $derived(!app.collapsed[folder.path]);
  const sel = (path) => app.selected?.kind === kind && app.selected?.path === path;
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));

  function itemMenu(e, it) {
    openMenu(e, [
      { label: 'Open', action: () => select({ kind, path: it.path }) },
      { label: 'Rename…', action: () => onRename(it.path) },
      { label: 'Move to', items: folders.map((f) => ({ label: f.label, disabled: f.path === parentOf(it.path), hint: 'current', action: () => moveFile(it.path, f.path) })) },
      { separator: true },
      ...removeItems((mode) => deleteFile(it.path, it.name, mode)),
    ]);
  }

  function folderMenu(e, f) {
    openMenu(e, [
      { label: 'New here…', action: () => onNew(f.path) },
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
    class:drop-target={dnd.target === folder.path}
    class:dragging={dnd.item?.path === folder.path}
    style="padding-left: {depth * 12}px"
    role="treeitem"
    aria-selected="false"
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
    <button class="twisty" onclick={() => toggleCollapsed(folder.path, isOpen)} aria-label="toggle">{isOpen ? '▾' : '▸'}</button>
    <button class="label" onclick={() => toggleCollapsed(folder.path, isOpen)}>📁 {folder.label || folder.name}</button>
    <span class="actions">
      <button class="icon" title="New here" onclick={() => onNew(folder.path)}>＋</button>
      <button class="icon" title="New subfolder" onclick={() => newFolder(folder.path)}><FolderPlusIcon /></button>
      <button class="icon" title="Rename" onclick={() => moveFolder(folder.path)}>✎</button>
      <button class="icon" title="Delete or move to trash" onclick={() => deleteFolder(folder.path)}><Icon name="trash" size={13} /></button>
    </span>
  </div>
{/if}
{#if isOpen}
  {#each folder.folders as f (f.path)}
    <SectionTree folder={f} depth={depth + 1} {kind} {icon} {onNew} {onRename} {folders} />
  {/each}
  {#each folder.items as it (it.path)}
    <div
      class="item"
      class:selected={sel(it.path)}
      class:dragging={dnd.item?.path === it.path}
      style="padding-left: {(depth + 1) * 12 + 4}px"
      role="treeitem"
      aria-selected={sel(it.path)}
      tabindex="-1"
      draggable="true"
      ondragstart={(e) => dragStart(e, { kind: 'file', path: it.path })}
      ondragend={dragEnd}
      ondragover={(e) => dragOver(e, folder.path)}
      ondrop={(e) => drop(e, folder.path)}
      oncontextmenu={(e) => itemMenu(e, it)}
    >
      <button class="label" onclick={() => select({ kind, path: it.path })}>
        {icon} {it.name}
        {#if isDirty(it.path)}<span class="unsaved" title="unsaved changes">●</span>{/if}
        {#if app.running[it.path]}<span class="spinner"></span>{/if}
      </button>
      <span class="actions">
        <button class="icon" title="Rename" onclick={() => onRename(it.path)}>✎</button>
        <button class="icon" title="Delete or move to trash" onclick={() => deleteFile(it.path, it.name)}><Icon name="trash" size={13} /></button>
      </span>
    </div>
  {/each}
{/if}
