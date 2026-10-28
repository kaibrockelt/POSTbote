<script>
  import { api } from '../lib/api.js';
  import { app, createWorkspace, pickFolder, fail, toast } from '../lib/state.svelte.js';
  import { slug, parseYaml, MANIFEST } from '../lib/format.js';
  import { collectionImporters, importCollection } from '../lib/import/index.js';

  let { onclose } = $props();
  const local = app.info.mode === 'local';
  const home = app.info.setup?.collectionsDir || '';

  let mode = $state('new'); // new | open | import
  let name = $state('');
  let storage = $state('browser');
  let folder = $state('');
  let imported = $state(null); // { files, skipped, name, format?, warnings? }
  const formats = ['POSTBote zip', ...collectionImporters.map((i) => i.label)].join(', ');
  const accept = ['.zip', ...collectionImporters.flatMap((i) => i.accept || [])].join(',');
  let busy = $state(false);

  const sep = home.includes('\\') ? '\\' : '/';
  const target = $derived(home ? home.replace(/[\\/]+$/, '') + sep + slug(name || imported?.name || 'collection') : '');

  async function browse() {
    const picked = await pickFolder(folder || home);
    if (picked) folder = picked;
  }

  async function onfile(e) {
    const file = e.currentTarget.files[0];
    if (!file) return;
    try {
      if (!/\.zip$/i.test(file.name)) {
        // foreign formats are converted in the browser into a new collection
        const res = importCollection(await file.text(), file.name);
        imported = { ...res, skipped: [] };
        if (!name) name = res.name;
        return;
      }
      const res = await api.importZip(file);
      const n = parseYaml(res.files[MANIFEST] || '').doc?.name || file.name.replace(/\.zip$/i, '');
      imported = { ...res, name: n };
      if (!name) name = n;
      if (!res.files[MANIFEST]) toast('The archive has no postbote.yaml – it will be imported as plain files.', 'error');
    } catch (err) {
      fail(err);
    }
  }

  async function submit(e) {
    e.preventDefault();
    busy = true;
    try {
      const files = mode === 'import' ? imported?.files : undefined;
      if (!local) {
        await createWorkspace({ name: name || imported?.name || 'New collection', storage, files });
      } else if (mode === 'open') {
        await createWorkspace({ storage: 'disk', path: folder, files: {} });
      } else {
        await createWorkspace({ name: name || imported?.name, storage: 'disk', files });
      }
      onclose();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  const valid = $derived(mode === 'import' ? !!imported : mode === 'open' ? !!folder.trim() : !!name.trim());
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <form class="modal wide" onsubmit={submit}>
    <h3>Add a collection</h3>
    <div class="row gap seg">
      <label class="check"><input type="radio" bind:group={mode} value="new" /> Create new</label>
      {#if local}<label class="check"><input type="radio" bind:group={mode} value="open" /> Add existing folder</label>{/if}
      <label class="check"><input type="radio" bind:group={mode} value="import" /> Import</label>
    </div>

    {#if mode === 'open'}
      <label class="field">
        <span>Collection folder (contains postbote.yaml)</span>
        <div class="row gap">
          <input class="mono grow" bind:value={folder} placeholder="/path/to/project/api-collection" />
          <button type="button" onclick={browse}>Browse…</button>
        </div>
      </label>
      <p class="hint">For collections outside your collections folder, e.g. inside a project repository. Files stay where they are.</p>
    {:else}
      {#if mode === 'import'}
        <label class="field"><span>File ({formats})</span><input type="file" {accept} onchange={onfile} /></label>
        {#if imported}
          <p class="muted">
            {imported.format ? `${imported.format}: ` : ''}{Object.keys(imported.files).length} files{imported.skipped.length ? `, ${imported.skipped.length} skipped (binary/invalid)` : ''}
          </p>
          {#if imported.warnings?.length}
            <ul class="warnings">
              {#each imported.warnings as w}<li>{w}</li>{/each}
            </ul>
          {/if}
        {/if}
      {/if}
      <label class="field"><span>Name</span><input bind:value={name} placeholder="My API" /></label>
      {#if local}
        <p class="hint">Created in <code class="mono">{target}</code> – ready for <code>git init</code>.</p>
      {:else}
        <div class="field">
          <span>Storage</span>
          <label class="check">
            <input type="radio" bind:group={storage} value="browser" /> In this browser <span class="muted">(default; nothing is stored on the server)</span>
          </label>
          <label class="check" class:disabled={!app.info.serverStorage}>
            <input type="radio" bind:group={storage} value="server" disabled={!app.info.serverStorage} /> On the server, private to you
            <span class="muted">{app.info.serverStorage ? '(opt-in, available on every device)' : '(disabled by the administrator)'}</span>
          </label>
        </div>
      {/if}
    {/if}

    <div class="row end gap">
      <button type="button" onclick={onclose}>Cancel</button>
      <button type="submit" class="primary" disabled={!valid || busy}>{mode === 'open' ? 'Add' : mode === 'import' ? 'Import' : 'Create'}</button>
    </div>
  </form>
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field > span {
    font-size: 12px;
    color: var(--fg-2);
  }
  .seg {
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .disabled {
    opacity: 0.5;
  }
  .warnings {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
    color: var(--warn);
    max-height: 140px;
    overflow: auto;
  }
</style>
