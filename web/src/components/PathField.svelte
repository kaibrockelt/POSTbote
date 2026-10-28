<script>
  // Path input with suggestions from the collection's data files: all of them
  // while empty, filtered while typing; arrows + Enter or click to pick.
  import { app } from '../lib/state.svelte.js';

  let { value = $bindable(''), placeholder = '' } = $props();
  let open = $state(false);
  let active = $state(0);

  // collection internals are no data files
  const INTERNAL = /^(postbote\.yaml$|\.gitignore$|README\.md$|requests\/|runners\/|workflows\/|environments\/|\.cookies\/)/;
  const all = $derived(Object.keys(app.files).filter((p) => !INTERNAL.test(p)).sort());
  const matches = $derived.by(() => {
    const q = (value || '').toLowerCase();
    if (!q) return all.slice(0, 50);
    const starts = all.filter((p) => p.toLowerCase().startsWith(q));
    const contains = all.filter((p) => !p.toLowerCase().startsWith(q) && p.toLowerCase().includes(q));
    return [...starts, ...contains].filter((p) => p !== value).slice(0, 50);
  });

  function pick(p) {
    value = p;
    open = false;
  }
  function onkeydown(e) {
    if (!open || !matches.length) return;
    if (e.key === 'ArrowDown') active = (active + 1) % matches.length;
    else if (e.key === 'ArrowUp') active = (active - 1 + matches.length) % matches.length;
    else if (e.key === 'Enter') pick(matches[active]);
    else if (e.key === 'Escape') open = false;
    else return;
    e.preventDefault();
  }
</script>

<div class="path-field">
  <input
    class="mono"
    bind:value
    {placeholder}
    spellcheck="false"
    autocomplete="off"
    onfocus={() => ((open = true), (active = 0))}
    oninput={() => ((open = true), (active = 0))}
    onblur={() => setTimeout(() => (open = false), 150)}
    {onkeydown}
  />
  {#if open && matches.length}
    <ul class="menu" role="listbox">
      {#each matches as p, i (p)}
        <li role="option" aria-selected={i === active} class:active={i === active} onmousedown={(e) => (e.preventDefault(), pick(p))}>{p}</li>
      {/each}
    </ul>
  {:else if open && !all.length && !value}
    <ul class="menu"><li class="muted">No data files in the collection yet</li></ul>
  {/if}
</div>

<style>
  .path-field {
    position: relative;
  }
  .path-field input {
    width: 100%;
  }
  .menu {
    position: absolute;
    z-index: 20;
    left: 0;
    right: 0;
    top: calc(100% + 2px);
    margin: 0;
    padding: 4px 0;
    list-style: none;
    max-height: 220px;
    overflow: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  li {
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  li.active,
  li:hover {
    background: var(--bg-2);
  }
</style>
