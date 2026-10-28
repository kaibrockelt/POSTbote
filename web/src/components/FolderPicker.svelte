<script>
  // Folder browser for the local app when no native dialog is available.
  import { api } from '../lib/api.js';
  import { fail } from '../lib/state.svelte.js';

  let { start = '', onpick, oncancel } = $props();
  let view = $state(null);

  async function go(path) {
    try {
      view = await api.browse(path);
    } catch (e) {
      fail(e);
    }
  }
  go(start);
  const join = (dir, name) => (dir.endsWith(view.sep) ? dir + name : dir + view.sep + name);
</script>

<div class="backdrop">
  <div class="modal wide">
    <h3>Choose a folder</h3>
    {#if view}
      <div class="row gap">
        <button class="small" disabled={!view.parent} onclick={() => go(view.parent)}>↑ Up</button>
        <input class="mono grow" value={view.path} onchange={(e) => go(e.currentTarget.value)} />
      </div>
      {#if view.isCollection}<p class="pill ok">This folder is a POSTBote collection</p>{/if}
      <div class="dirs">
        {#each view.dirs as d}
          <button class="dir" ondblclick={() => go(join(view.path, d))} onclick={() => go(join(view.path, d))}>📁 {d}</button>
        {:else}
          <p class="muted">No subfolders.</p>
        {/each}
      </div>
    {/if}
    <div class="row end gap">
      <button onclick={oncancel}>Cancel</button>
      <button class="primary" disabled={!view} onclick={() => onpick(view.path)}>Use this folder</button>
    </div>
  </div>
</div>

<style>
  .dirs {
    height: 320px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px;
  }
  .dir {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    padding: 4px 8px;
  }
  .dir:hover {
    background: var(--bg-2);
  }
</style>
