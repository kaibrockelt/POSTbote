<script>
  import KvTable from './KvTable.svelte';
  import FileEditor from './FileEditor.svelte';
  import { app, contentOf, setDraft, renameFile, setEnv, fail } from '../lib/state.svelte.js';
  import { parseEnv, updateEnv, envName, isPublicEnv } from '../lib/format.js';

  let { path } = $props();
  let mode = $state('table');
  let masked = $state(!isPublicEnv(path));
  let rows = $state([]);
  let last = null;

  $effect(() => {
    const text = contentOf(path);
    if (text === last) return;
    last = text;
    rows = parseEnv(text).map((r) => ({ ...r, file: '', disabled: false }));
  });
  $effect(() => {
    const snap = $state.snapshot(rows);
    if (last === null) return;
    const text = updateEnv(last, snap.filter((r) => r.key.trim()));
    // only write when the content actually changed (not on open)
    const same = JSON.stringify(parseEnv(text)) === JSON.stringify(parseEnv(last));
    if (!same) {
      last = text;
      const saved = app.files[path] ?? '';
      setDraft(path, JSON.stringify(parseEnv(saved)) === JSON.stringify(parseEnv(text)) ? saved : text);
    }
  });

  async function toggleVisibility() {
    const to = isPublicEnv(path) ? path.replace(/\.pub$/, '') : path + '.pub';
    try {
      await renameFile(path, to);
    } catch (e) {
      fail(e);
    }
  }
</script>

<div class="page">
  <div class="row between">
    <h2>{envName(path)}</h2>
    <div class="row gap">
      <span class="pill {isPublicEnv(path) ? 'warn' : 'ok'}">{isPublicEnv(path) ? 'public · committed' : 'private · gitignored'}</span>
      <button class="small" onclick={toggleVisibility}>{isPublicEnv(path) ? 'Make private' : 'Make public'}</button>
      {#if app.env !== path}<button class="small" onclick={() => setEnv(path)}>Activate</button>{/if}
    </div>
  </div>
  <p class="hint">
    {#if isPublicEnv(path)}
      <code>{path}</code> is checked into git. Do not store secrets here.
    {:else}
      <code>{path}</code> is excluded from git by <code>.gitignore</code> (unless the collection commits all environments). Scripts can
      update it via <code>env.set()</code>.
    {/if}
  </p>
  <div class="row gap">
    <label class="check"><input type="radio" bind:group={mode} value="table" /> Table</label>
    <label class="check"><input type="radio" bind:group={mode} value="raw" /> Raw file</label>
    {#if mode === 'table'}<label class="check"><input type="checkbox" bind:checked={masked} /> Hide values</label>{/if}
  </div>
  {#if mode === 'table'}
    <KvTable bind:rows toggle={false} keyPlaceholder="VARIABLE" secret={masked} />
  {:else}
    <FileEditor {path} />
  {/if}
</div>
