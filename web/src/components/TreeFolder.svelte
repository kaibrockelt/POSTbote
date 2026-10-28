<script>
  import TreeFolder from './TreeFolder.svelte';
  import { app, select } from '../lib/state.svelte.js';
  import { newRequest, newFolder, renameRequest, duplicateRequest, moveFolder, deleteFolder, deleteFile } from '../lib/actions.js';

  let { folder, depth = 0, collapsed = $bindable({}) } = $props();
  const isOpen = $derived(!collapsed[folder.path]);
  const sel = (kind, path) => app.selected?.kind === kind && app.selected?.path === path;
</script>

{#if depth > 0}
  <div class="item folder" class:selected={sel('folder', folder.path)} style="padding-left: {depth * 12}px">
    <button class="twisty" onclick={() => (collapsed[folder.path] = isOpen)} aria-label="toggle">{isOpen ? '▾' : '▸'}</button>
    <button class="label" onclick={() => select({ kind: 'folder', path: folder.path })}>📁 {folder.label || folder.name}</button>
    <span class="actions">
      <button class="icon" title="New request" onclick={() => newRequest(folder.path)}>＋</button>
      <button class="icon" title="New subfolder" onclick={() => newFolder(folder.path)}>⊞</button>
      <button class="icon" title="Rename" onclick={() => moveFolder(folder.path)}>✎</button>
      <button class="icon" title="Delete" onclick={() => deleteFolder(folder.path)}>🗑</button>
    </span>
  </div>
{/if}
{#if isOpen}
  {#each folder.folders as f (f.path)}
    <TreeFolder folder={f} depth={depth + 1} bind:collapsed />
  {/each}
  {#each folder.requests as r (r.path)}
    <div class="item" class:selected={sel('request', r.path)} style="padding-left: {(depth + 1) * 12 + 4}px">
      <button class="label" onclick={() => select({ kind: 'request', path: r.path })} title={r.path}>
        <span class="method m-{r.method}">{r.method === 'DELETE' ? 'DEL' : r.method === 'OPTIONS' ? 'OPT' : r.method}</span>
        {r.name}
        {#if app.running[r.path]}<span class="spinner"></span>{/if}
      </button>
      <span class="actions">
        <button class="icon" title="Rename" onclick={() => renameRequest(r.path)}>✎</button>
        <button class="icon" title="Duplicate" onclick={() => duplicateRequest(r.path)}>⧉</button>
        <button class="icon" title="Delete" onclick={() => deleteFile(r.path, r.name)}>🗑</button>
      </span>
    </div>
  {/each}
{/if}
