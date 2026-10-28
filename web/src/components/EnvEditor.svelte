<script>
  // An environment = shared values (<name>.env.pub, committed) overlaid by
  // private values (<name>.env, gitignored). Both are edited here as drafts.
  import KvTable from './KvTable.svelte';
  import { app, contentOf, setDraft, setEnv } from '../lib/state.svelte.js';
  import { parseEnv, updateEnv, envPublicPath, envPrivatePath, getEnvTint, setEnvTint, isTint } from '../lib/format.js';

  let { path: name } = $props(); // env tabs are keyed by name
  const files = { pub: envPublicPath(name), priv: envPrivatePath(name) };

  let masked = $state(true);
  let rows = $state({ pub: [], priv: [] });
  const last = { pub: null, priv: null };

  const toRows = (text) => parseEnv(text).map((r) => ({ ...r, file: '', disabled: false }));
  const sameVars = (a, b) => JSON.stringify(parseEnv(a)) === JSON.stringify(parseEnv(b)) && getEnvTint(a) === getEnvTint(b);

  // follow file/draft changes (run results, revert, reload)
  $effect(() => {
    for (const k of ['pub', 'priv']) {
      const text = contentOf(files[k]);
      if (text !== last[k]) {
        last[k] = text;
        rows[k] = toRows(text);
      }
    }
  });

  // edits become drafts; editing back to the saved content clears the draft
  function sync(k) {
    if (last[k] === null) return;
    const snap = $state.snapshot(rows[k]).filter((r) => r.key.trim());
    const text = updateEnv(last[k], snap);
    if (sameVars(text, last[k])) return;
    last[k] = text;
    const saved = app.files[files[k]] ?? '';
    setDraft(files[k], sameVars(saved, text) ? saved : text);
  }
  $effect(() => {
    $state.snapshot(rows.pub);
    sync('pub');
  });
  $effect(() => {
    $state.snapshot(rows.priv);
    sync('priv');
  });

  // effective values: private wins unless it is empty
  const effective = $derived.by(() => {
    const m = new Map();
    for (const r of rows.pub) if (r.key) m.set(r.key, { key: r.key, value: r.value, from: 'shared' });
    for (const r of rows.priv) {
      if (!r.key) continue;
      if (r.value === '' && m.get(r.key)?.value) continue;
      m.set(r.key, { key: r.key, value: r.value, from: 'private' });
    }
    return [...m.values()];
  });
  const missing = $derived(effective.filter((e) => e.value === '').map((e) => e.key));

  // window tint while this environment is active; stored in the shared file
  const swatches = [
    ['Red', '#f38ba8'],
    ['Peach', '#fab387'],
    ['Yellow', '#f9e2af'],
    ['Green', '#a6e3a1'],
    ['Teal', '#94e2d5'],
    ['Blue', '#89b4fa'],
    ['Mauve', '#cba6f7'],
    ['Pink', '#f5c2e7'],
  ];
  const tint = $derived(getEnvTint(contentOf(files.pub)));
  const custom = $derived(!!tint && !swatches.some(([, c]) => c === tint));
  let hex = $state('');
  $effect(() => {
    hex = tint;
  });
  function setTint(c) {
    const text = setEnvTint(contentOf(files.pub), c);
    last.pub = text;
    setDraft(files.pub, text);
  }
  function onhex(e) {
    let v = e.currentTarget.value.trim();
    if (v && !v.startsWith('#')) v = '#' + v;
    if (v === '' || isTint(v)) setTint(v);
  }

  function overridePrivately(key) {
    if (!rows.priv.some((r) => r.key === key)) rows.priv.push({ key, value: '', file: '', disabled: false });
  }
</script>

<div class="page env">
  <div class="row between">
    <h2>{name}</h2>
    {#if app.env === name}
      <span class="pill ok">active</span>
    {:else}
      <button class="small" onclick={() => setEnv(name)}>Activate</button>
    {/if}
  </div>

  <div class="tint row gap">
    <span class="muted small">Window tint</span>
    <button class="swatch none" class:on={!tint} title="Default (no tint)" aria-label="No tint" onclick={() => setTint('')}></button>
    {#each swatches as [label, c] (c)}
      <button class="swatch" class:on={tint === c} style="--c: {c}" title={label} aria-label="{label} tint" onclick={() => setTint(c)}></button>
    {/each}
    <input type="color" class="picker" class:on={custom} style={custom ? `background: ${tint}` : ''} value={tint || '#f38ba8'} title="Pick a color" oninput={(e) => setTint(e.currentTarget.value)} />
    <input class="hex mono" placeholder="#rrggbb" bind:value={hex} onchange={onhex} spellcheck="false" aria-label="Tint as hex" />
  </div>

  <section>
    <div class="row between">
      <h3>Shared <span class="file mono">{files.pub}</span></h3>
      <span class="pill warn">committed</span>
    </div>
    <p class="hint">Visible to everyone with the repository. Declare every variable here and leave secrets empty (e.g. <code>token=</code>).</p>
    <KvTable bind:rows={rows.pub} toggle={false} keyPlaceholder="VARIABLE" />
  </section>

  <section>
    <div class="row between">
      <h3>Private overrides <span class="file mono">{files.priv}</span></h3>
      <div class="row gap">
        <label class="check small"><input type="checkbox" bind:checked={masked} /> hide values</label>
        <span class="pill ok">gitignored</span>
      </div>
    </div>
    <p class="hint">Only on this machine. Overrides shared values with the same name (empty values don’t); <code>env.set()</code> in scripts writes here.</p>
    <KvTable bind:rows={rows.priv} toggle={false} keyPlaceholder="VARIABLE" secret={masked} />
  </section>

  <section>
    <h3>Effective values</h3>
    {#if effective.length}
      <table class="grid mono">
        <tbody>
          {#each effective as e (e.key)}
            <tr>
              <td>{e.key}</td>
              <td>
                {#if e.value === ''}
                  <span class="empty">not set</span>
                  {#if e.from === 'shared'}<button class="link small" onclick={() => overridePrivately(e.key)}>set privately</button>{/if}
                {:else}
                  {e.from === 'private' && masked ? '••••••' : e.value}
                {/if}
              </td>
              <td><span class="src src-{e.from}">{e.from}</span></td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if missing.length}<p class="hint warn">Not set: {missing.join(', ')}</p>{/if}
    {:else}
      <p class="muted">No variables yet.</p>
    {/if}
  </section>
</div>

<style>
  .tint {
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .swatch {
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--c);
    cursor: pointer;
  }
  .swatch.none {
    background: linear-gradient(135deg, transparent 45%, var(--fg-3) 45% 55%, transparent 55%), var(--bg);
  }
  .swatch.on {
    outline: 2px solid var(--fg-2);
    outline-offset: 1px;
  }
  /* custom colour: a rainbow swatch that opens the native picker */
  .picker {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: conic-gradient(#f38ba8, #f9e2af, #a6e3a1, #94e2d5, #89b4fa, #cba6f7, #f38ba8);
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
  }
  .picker::-webkit-color-swatch-wrapper {
    padding: 0;
  }
  .picker::-webkit-color-swatch {
    border: none;
    opacity: 0;
  }
  .picker::-moz-color-swatch {
    border: none;
    opacity: 0;
  }
  .picker.on {
    outline: 2px solid var(--fg-2);
    outline-offset: 1px;
  }
  .hex {
    width: 84px;
    padding: 2px 6px;
    font-size: 12px;
  }
  .env section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .env h3 {
    margin: 0;
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .file {
    font-weight: normal;
    font-size: 11.5px;
    color: var(--fg-3);
  }
  .hint {
    margin: 0 0 4px;
  }
  .warn {
    color: var(--warn);
  }
  .empty {
    color: var(--v-miss);
    margin-right: 8px;
  }
  .src {
    font-size: 11px;
    padding: 0 6px;
    border-radius: 8px;
  }
  .src-shared {
    color: var(--v-envpub);
    background: var(--v-envpub-bg);
  }
  .src-private {
    color: var(--v-env);
    background: var(--v-env-bg);
  }
</style>
