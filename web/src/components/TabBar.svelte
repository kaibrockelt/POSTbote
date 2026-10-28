<script>
  import { app, select, closeTab, saveTab, saveTabAs, discardTab, tabDirty, tabTitle, sameTab, tabFile, fail } from '../lib/state.svelte.js';
  import { parseYaml } from '../lib/format.js';

  const active = $derived(app.selected);
  const activeDirty = $derived(active ? tabDirty(active) : false);
  const canSaveAs = $derived(active && ['request', 'workflow', 'env', 'file'].includes(active.kind));

  function method(t) {
    const m = String(parseYaml(app.drafts[t.path] ?? app.files[t.path] ?? '').doc?.method || 'GET').toUpperCase();
    return m === 'DELETE' ? 'DEL' : m === 'OPTIONS' ? 'OPT' : m;
  }
  const icon = { workflow: '⇶', graph: '◇', env: '◉', folder: '📁', collection: '⚙', file: '📄' };

  const guard = (fn) => () => fn().catch(fail);

  function onauxclick(e, t) {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(t).catch(fail);
    }
  }
</script>

<div class="tabbar">
  <div class="tabs" role="tablist">
    {#each app.tabs as t (`${t.kind}:${t.path}`)}
      {@const dirty = tabDirty(t)}
      <div
        class="tab"
        class:active={sameTab(t, active)}
        class:dirty
        role="tab"
        tabindex="0"
        aria-selected={sameTab(t, active)}
        title={tabFile(t) + (dirty ? ' (unsaved)' : '')}
        onclick={() => select(t)}
        onkeydown={(e) => e.key === 'Enter' && select(t)}
        onauxclick={(e) => onauxclick(e, t)}
      >
        {#if t.kind === 'request'}
          <span class="method m-{method(t) === 'DEL' ? 'DELETE' : method(t)}">{method(t)}</span>
        {:else}
          <span class="kind">{icon[t.kind]}</span>
        {/if}
        <span class="title">{tabTitle(t)}</span>
        <button
          class="close"
          title={dirty ? 'Unsaved changes – close' : 'Close'}
          onclick={(e) => {
            e.stopPropagation();
            closeTab(t).catch(fail);
          }}
        >
          <span class="x">✕</span><span class="dot">●</span>
        </button>
      </div>
    {/each}
  </div>
  {#if active}
    <div class="actions">
      {#if activeDirty}
        <button class="link small" title="Throw away unsaved changes" onclick={() => discardTab(active)}>Revert</button>
      {/if}
      {#if canSaveAs}
        <button class="small" title="Save a copy under a new name; the saved original stays unchanged" onclick={guard(() => saveTabAs(active))}>Save as…</button>
      {/if}
      <button class="small primary" disabled={!activeDirty} title="Save (⌘/Ctrl+S)" onclick={guard(() => saveTab(active))}>Save</button>
    </div>
  {/if}
</div>

<style>
  .tabbar {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--border);
    background: var(--bg-1);
    min-height: 36px;
    flex-shrink: 0;
  }
  .tabs {
    display: flex;
    overflow-x: auto;
    flex: 1;
    min-width: 0;
    scrollbar-width: thin;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 12px;
    max-width: 220px;
    border-right: 1px solid var(--border);
    cursor: pointer;
    color: var(--fg-2);
    white-space: nowrap;
    position: relative;
    user-select: none;
  }
  .tab:hover {
    background: var(--bg-2);
  }
  .tab.active {
    background: var(--bg);
    color: var(--fg);
  }
  .tab.active::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    background: var(--accent);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab.dirty .title {
    font-style: italic;
  }
  .kind {
    font-size: 11px;
    color: var(--fg-3);
  }
  .tab .method {
    width: auto;
  }
  .close {
    background: none;
    border: none;
    padding: 0;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--fg-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    flex-shrink: 0;
  }
  .close:hover {
    background: var(--bg-3);
    color: var(--fg);
  }
  /* VS Code style: unsaved tabs show a dot that turns into ✕ on hover */
  .close .dot {
    display: none;
    color: var(--accent);
    font-size: 13px;
  }
  .tab.dirty .close .x {
    display: none;
  }
  .tab.dirty .close .dot {
    display: inline;
  }
  .tab.dirty .close:hover .x {
    display: inline;
  }
  .tab.dirty .close:hover .dot {
    display: none;
  }
  .tab:not(.dirty):not(.active):not(:hover) .close .x {
    visibility: hidden;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-left: 1px solid var(--border);
    flex-shrink: 0;
  }
</style>
