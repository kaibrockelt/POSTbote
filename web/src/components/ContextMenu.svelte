<script>
  import { app } from '../lib/state.svelte.js';

  let el = $state();
  let pos = $state({ x: 0, y: 0 });
  let open = $state(-1); // index of the opened submenu

  // keep the menu inside the window
  $effect(() => {
    if (!app.menu || !el) return;
    const r = el.getBoundingClientRect();
    pos = { x: Math.min(app.menu.x, window.innerWidth - r.width - 8), y: Math.min(app.menu.y, window.innerHeight - r.height - 8) };
    open = -1;
  });

  const close = () => (app.menu = null);
  function run(item) {
    if (item.disabled || item.items) return;
    close();
    item.action?.();
  }
  function onkeydown(e) {
    if (app.menu && e.key === 'Escape') close();
  }
</script>

<svelte:window {onkeydown} onblur={close} onresize={close} />

{#if app.menu}
  <div class="menu-backdrop" role="presentation" onmousedown={close} oncontextmenu={(e) => (e.preventDefault(), close())}></div>
  <ul class="cmenu" bind:this={el} style="left: {pos.x}px; top: {pos.y}px" role="menu">
    {#each app.menu.items as item, i}
      {#if item.separator}
        <li class="sep" role="separator"></li>
      {:else}
        <li role="none" class="has-sub" onmouseenter={() => (open = item.items ? i : -1)}>
          <button role="menuitem" class:danger={item.danger} disabled={item.disabled} onclick={() => (item.items ? (open = i) : run(item))}>
            <span>{item.label}</span>
            {#if item.items}<span class="arrow">▸</span>{/if}
          </button>
          {#if item.items && open === i}
            <ul class="cmenu sub" role="menu">
              {#each item.items as sub}
                <li role="none">
                  <button role="menuitem" disabled={sub.disabled} onclick={() => run(sub)}>
                    <span>{sub.label}</span>
                    {#if sub.disabled && sub.hint}<span class="hint-txt">{sub.hint}</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
{/if}

<style>
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 80;
  }
  .cmenu {
    position: fixed;
    z-index: 81;
    list-style: none;
    margin: 0;
    padding: 4px;
    min-width: 190px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.2);
    font-size: 13px;
  }
  .cmenu.sub {
    position: absolute;
    left: calc(100% - 4px);
    top: -5px;
    max-height: 60vh;
    overflow: auto;
  }
  .has-sub {
    position: relative;
  }
  button {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    padding: 5px 10px;
    border-radius: 5px;
    white-space: nowrap;
  }
  button:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .danger {
    color: var(--bad);
  }
  .arrow,
  .hint-txt {
    color: var(--fg-3);
    font-size: 11px;
  }
  .sep {
    height: 1px;
    background: var(--border);
    margin: 4px 6px;
  }
</style>
