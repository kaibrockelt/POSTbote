<script>
  // Text field with {{variable}} highlighting and autocomplete.
  // The variable scope comes from the 'vars' context (set by the editors);
  // without it the field behaves like a plain input/textarea.
  import { getContext, tick } from 'svelte';
  import { tokenize, SOURCE_LABEL } from '../lib/vars.js';
  import { caretCoords } from '../lib/caret.js';

  let {
    value = $bindable(''),
    placeholder = '',
    multiline = false,
    rows = 8,
    type = 'text',
    class: cls = '',
    onpaste = undefined,
    onkeydown: userKeydown = undefined,
  } = $props();

  const getScope = getContext('vars');
  const scope = $derived(getScope ? getScope() : null);
  const segments = $derived(scope && type !== 'password' && value?.includes('{{') ? tokenize(value, scope) : null);

  let el = $state();
  let overlay = $state();
  let menu = $state(null); // { start, query, items, index, x, y }

  function syncScroll() {
    if (overlay && el) {
      overlay.scrollLeft = el.scrollLeft;
      overlay.scrollTop = el.scrollTop;
    }
  }

  function candidates(query) {
    const q = query.toLowerCase();
    const all = [...scope.values()];
    const starts = all.filter((v) => v.name.toLowerCase().startsWith(q));
    const contains = all.filter((v) => !v.name.toLowerCase().startsWith(q) && v.name.toLowerCase().includes(q));
    const order = { input: 0, request: 1, env: 2, envpub: 3, folder: 4, collection: 5, runtime: 6, builtin: 7 };
    const sort = (a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name);
    return [...starts.sort(sort), ...contains.sort(sort)].slice(0, 50);
  }

  // opens the menu while the caret is inside an unfinished {{…
  function updateMenu() {
    syncScroll();
    if (!scope || !el) return (menu = null);
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd) return (menu = null);
    const before = value.slice(0, pos);
    const m = before.match(/\{\{\s*([^{}\s]*)$/);
    if (!m) return (menu = null);
    const items = candidates(m[1]);
    if (!items.length) return (menu = null);
    const start = pos - m[1].length;
    // fixed positioning, so scrolling/clipping parents cannot cut the menu off
    const c = caretCoords(el, start);
    const rect = el.getBoundingClientRect();
    const x = rect.left + c.left - el.scrollLeft - 6;
    const below = rect.top + c.top - el.scrollTop + c.height + 4;
    menu = {
      start,
      query: m[1],
      items,
      index: menu && menu.start === start ? Math.min(menu.index, items.length - 1) : 0,
      x: Math.max(8, Math.min(x, window.innerWidth - 400)),
      y: below + 290 > window.innerHeight ? Math.max(8, below - c.height - 300) : below,
    };
  }

  async function insert(item) {
    const pos = el.selectionStart;
    const after = value.slice(pos);
    const close = /^\s*\}\}/.test(after) ? '' : '}}';
    value = value.slice(0, menu.start) + item.name + close + after;
    const caret = menu.start + item.name.length + (close ? 2 : after.match(/^\s*\}\}/)[0].length);
    menu = null;
    await tick();
    el.focus();
    el.setSelectionRange(caret, caret);
    syncScroll();
  }

  function onkeydown(e) {
    if (menu) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = menu.items.length;
        menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        insert(menu.items[menu.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        menu = null;
        return;
      }
    }
    if (multiline && e.key === 'Tab') {
      // indent instead of leaving the field
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = el;
      value = value.slice(0, s) + '  ' + value.slice(end);
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
      return;
    }
    userKeydown?.(e);
  }

  const preview = (v) => {
    if (v.source === 'builtin') return 'generated';
    if (v.source === 'runtime') return 'runtime';
    if (v.masked && v.value) return '••••••';
    return v.value === '' ? '(empty)' : v.value.length > 48 ? v.value.slice(0, 48) + '…' : v.value;
  };
</script>

<div class="vf {cls}" class:multi={multiline}>
  {#if segments}
    <div class="overlay mono-like" class:multi={multiline} bind:this={overlay} aria-hidden="true">
      {#each segments as s}{#if s.source}<span class="v v-{s.source}">{s.text}</span>{:else}{s.text}{/if}{/each}{'\n'}
    </div>
  {/if}
  {#if multiline}
    <textarea
      bind:this={el}
      bind:value
      class:has-overlay={!!segments}
      {placeholder}
      {rows}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      oninput={updateMenu}
      onclick={updateMenu}
      onkeyup={(e) => !['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && updateMenu()}
      onscroll={syncScroll}
      onblur={() => setTimeout(() => (menu = null), 120)}
      {onkeydown}
      {onpaste}
    ></textarea>
  {:else}
    <input
      bind:this={el}
      bind:value
      class:has-overlay={!!segments}
      {type}
      {placeholder}
      spellcheck="false"
      autocomplete="off"
      oninput={updateMenu}
      onclick={updateMenu}
      onkeyup={(e) => !['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && updateMenu()}
      onscroll={syncScroll}
      onblur={() => setTimeout(() => (menu = null), 120)}
      {onkeydown}
      {onpaste}
    />
  {/if}
  {#if menu}
    <ul class="menu" style="left: {menu.x}px; top: {menu.y}px" role="listbox">
      {#each menu.items as item, i (item.name)}
        <li role="option" aria-selected={i === menu.index}>
          <button
            type="button"
            class:active={i === menu.index}
            title="{SOURCE_LABEL[item.source]} · {item.label}"
            onmousedown={(e) => {
              e.preventDefault();
              insert(item);
            }}
          >
            <span class="dot d-{item.source}"></span>
            <span class="name">{item.name}</span>
            <span class="val">{preview(item)}</span>
            <span class="src">{item.label}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .vf {
    position: relative;
    display: flex;
    min-width: 0;
  }
  .vf > input,
  .vf > textarea {
    flex: 1;
    min-width: 0;
    position: relative;
    background: transparent !important;
    font-family: inherit;
  }
  .vf.multi > textarea {
    width: 100%;
    resize: vertical;
    tab-size: 2;
    line-height: 1.45;
    white-space: pre;
    overflow: auto;
  }
  .vf {
    background: var(--bg);
    border-radius: 6px;
  }
  /* the text is drawn by the overlay; the field keeps caret and selection */
  .has-overlay {
    color: transparent !important;
    caret-color: var(--fg);
  }
  .has-overlay::selection {
    color: transparent;
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .overlay {
    position: absolute;
    inset: 0;
    border: 1px solid transparent;
    padding: 6px 8px;
    white-space: pre;
    overflow: hidden;
    pointer-events: none;
    color: var(--fg);
    font: inherit;
  }
  .overlay.multi {
    line-height: 1.45;
    tab-size: 2;
  }
  .v {
    border-radius: 3px;
  }
  .v-collection {
    color: var(--v-col);
    background: var(--v-col-bg);
  }
  .v-folder {
    color: var(--v-fold);
    background: var(--v-fold-bg);
  }
  .v-envpub {
    color: var(--v-envpub);
    background: var(--v-envpub-bg);
  }
  .v-env {
    color: var(--v-env);
    background: var(--v-env-bg);
  }
  .v-missing {
    color: var(--v-miss);
    background: var(--v-miss-bg);
  }
  .v-runtime {
    color: var(--v-run);
    background: var(--v-run-bg);
  }
  .v-builtin {
    color: var(--v-built);
    background: var(--v-built-bg);
  }
  .v-request {
    color: var(--v-fold);
    background: var(--v-fold-bg);
    font-weight: 600;
  }
  .v-input {
    color: var(--v-run);
    background: var(--v-run-bg);
    font-style: italic;
  }
  .menu {
    position: fixed;
    z-index: 70;
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.18);
    min-width: 320px;
    max-width: 560px;
    max-height: 280px;
    overflow: auto;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 12.5px;
  }
  .menu button {
    display: grid;
    grid-template-columns: 10px auto 1fr auto;
    gap: 8px;
    align-items: center;
    width: 100%;
    border: none;
    background: none;
    text-align: left;
    padding: 4px 8px;
    border-radius: 5px;
  }
  .menu button.active,
  .menu button:hover {
    background: var(--bg-2);
  }
  .name {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .val {
    color: var(--fg-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px;
  }
  .src {
    color: var(--fg-3);
    font-size: 11px;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .d-collection {
    background: var(--v-col);
  }
  .d-env {
    background: var(--v-env);
  }
  .d-envpub {
    background: var(--v-envpub);
  }
  .d-folder {
    background: var(--v-fold);
  }
  .d-runtime {
    background: var(--v-run);
  }
  .d-builtin {
    background: var(--v-built);
  }
  .d-input {
    background: var(--v-run);
  }
  .d-request {
    background: var(--v-fold);
  }
</style>
