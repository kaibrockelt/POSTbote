<script>
  let { tabs, active = $bindable() } = $props();
</script>

<div class="tabs" role="tablist">
  {#each tabs as t (t.id)}
    <button role="tab" aria-selected={active === t.id} class:active={active === t.id} onclick={() => (active = t.id)}>
      {t.label}
      {#if t.badge}<span class="badge {t.badgeKind || ''}">{t.badge}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 7px 10px;
    color: var(--fg-2);
    white-space: nowrap;
  }
  button:hover {
    color: var(--fg);
    background: none;
  }
  .active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .badge {
    font-size: 10.5px;
    background: var(--bg-3);
    border-radius: 8px;
    padding: 0 6px;
    margin-left: 4px;
  }
  .badge.ok {
    background: var(--ok-bg);
    color: var(--ok);
  }
  .badge.bad {
    background: var(--bad-bg);
    color: var(--bad);
  }
</style>
