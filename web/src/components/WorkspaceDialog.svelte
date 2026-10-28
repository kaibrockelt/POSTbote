<script>
  import { api } from '../lib/api.js';
  import { app, createWorkspace, pickFolder, fail, toast } from '../lib/state.svelte.js';
  import { slug, parseYaml, MANIFEST } from '../lib/format.js';
  import { collectionImporters, importCollection } from '../lib/import/index.js';
  import { buildCollectionFiles, countSecrets } from '../lib/import/build.js';

  let { onclose } = $props();
  const local = app.info.mode === 'local';
  const home = app.info.setup?.collectionsDir || '';

  let mode = $state('new'); // new | open | import
  let name = $state('');
  let storage = $state('browser');
  let folder = $state('');
  let imported = $state(null); // zip: { files, skipped, name }; other formats: { result, format, name, warnings, secrets }
  let secretsEnv = $state(''); // '' = keep, NEW_ENV = new environment named newEnvName, else an imported environment
  let newEnvName = $state('default');
  const NEW_ENV = '\0new';
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
    const chosen = [...e.currentTarget.files];
    if (!chosen.length) return;
    imported = null;
    try {
      const file = chosen.find((f) => /\.zip$/i.test(f.name));
      if (!file) {
        // foreign formats are converted in the browser; several files may
        // belong together (a collection and its environments)
        const res = importCollection(await Promise.all(chosen.map(async (f) => ({ name: f.name, text: await f.text() }))));
        imported = { result: res, format: res.format, name: res.name, warnings: res.warnings, secrets: countSecrets(res) };
        secretsEnv = '';
        name = res.name || name;
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
      let files = mode === 'import' ? imported?.files : undefined;
      if (mode === 'import' && imported?.result) {
        const env = secretsEnv === NEW_ENV ? newEnvName.trim() || 'default' : secretsEnv;
        const built = buildCollectionFiles({ ...$state.snapshot(imported.result), name: name || imported.name }, { secretsEnv: env });
        files = built.files;
        for (const n of built.notes) toast(n);
      }
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
        <label class="field">
          <span>File ({formats}) – select environment files together with the collection</span>
          <input type="file" {accept} multiple onchange={onfile} />
        </label>
        {#if imported?.result}
          {@const r = imported.result}
          <p class="muted">
            {imported.format}: {r.requests.length} request{r.requests.length === 1 ? '' : 's'}{r.folders.length ? `, ${r.folders.length} folder${r.folders.length === 1 ? '' : 's'}` : ''}{r.environments?.length
              ? `, environments: ${r.environments.map((e) => e.name).join(', ')}`
              : ''}
          </p>
          {#if imported.secrets}
            <label class="target row gap">
              <span class="muted small">{imported.secrets} token{imported.secrets > 1 ? 's/keys' : '/key'} in requests – store in</span>
              <select bind:value={secretsEnv}>
                <option value="">Nowhere (keep them in the requests)</option>
                <option value={NEW_ENV}>New environment…</option>
                {#each r.environments || [] as env (env.name)}<option value={env.name}>{env.name}</option>{/each}
              </select>
              {#if secretsEnv === NEW_ENV}<input class="env-name" bind:value={newEnvName} placeholder="environment name" />{/if}
            </label>
          {/if}
        {:else if imported}
          <p class="muted">
            {Object.keys(imported.files).length} files{imported.skipped.length ? `, ${imported.skipped.length} skipped (binary/invalid)` : ''}
          </p>
        {/if}
        {#if imported?.warnings?.length}
          <ul class="warnings">
            {#each imported.warnings as w}<li>{w}</li>{/each}
          </ul>
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
  .target {
    align-items: center;
    flex-wrap: wrap;
  }
  .env-name {
    width: 140px;
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
