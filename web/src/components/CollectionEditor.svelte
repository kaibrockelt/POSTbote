<script>
  import Tabs from './Tabs.svelte';
  import KvTable from './KvTable.svelte';
  import AuthEditor from './AuthEditor.svelte';
  import ScriptsEditor from './ScriptsEditor.svelte';
  import FileEditor from './FileEditor.svelte';
  import CookieJar from './CookieJar.svelte';
  import { setContext } from 'svelte';
  import { variableScope } from '../lib/vars.js';
  import { fileDoc } from '../lib/doc.svelte.js';
  import { parseCollection, serializeCollection, updateGitignore, MANIFEST } from '../lib/format.js';
  import { app, write, moveWorkspace, fail, toast, currentFiles } from '../lib/state.svelte.js';

  const d = fileDoc(MANIFEST, parseCollection, serializeCollection);
  const scope = $derived(variableScope(currentFiles(), app.env, ''));
  setContext('vars', () => scope);
  let tab = $state('general');

  const gitignoreOk = $derived(
    d.doc ? updateGitignore(app.files['.gitignore'] ?? '', d.doc.settings.commitEnvironments) === (app.files['.gitignore'] ?? '') : true,
  );
  function syncGitignore() {
    write('.gitignore', updateGitignore(app.files['.gitignore'] ?? '', d.doc.settings.commitEnvironments));
  }

  async function move(target) {
    try {
      await moveWorkspace(target);
      toast(target === 'server' ? 'Collection is now stored on the server' : 'Collection is now stored in this browser');
    } catch (e) {
      fail(e);
    }
  }
</script>

{#if d.error}
  <div class="error-box">Cannot parse postbote.yaml: {d.error}</div>
  <FileEditor path={MANIFEST} />
{:else if d.doc}
  <div class="page">
    <input class="title" bind:value={d.doc.name} placeholder="Collection name" />
    <Tabs
      tabs={[
        { id: 'general', label: 'General' },
        { id: 'vars', label: 'Variables' },
        { id: 'headers', label: 'Headers' },
        { id: 'auth', label: 'Auth' },
        { id: 'scripts', label: 'Scripts' },
        { id: 'storage', label: 'Storage & Git' },
        { id: 'cookies', label: 'Cookies' },
      ]}
      bind:active={tab}
    />
    <div class="tab-body form">
      {#if tab === 'general'}
        <label><span>Request timeout (ms)</span><input type="number" min="0" bind:value={d.doc.settings.timeoutMs} placeholder="30000" /></label>
        <label><span>Script timeout (ms)</span><input type="number" min="0" bind:value={d.doc.settings.scriptTimeoutMs} placeholder="10000" /></label>
        <label class="check"><input type="checkbox" bind:checked={d.doc.settings.followRedirects} /> Follow redirects</label>
        <label class="check"><input type="checkbox" bind:checked={d.doc.settings.verifyTls} /> Verify TLS certificates</label>
      {:else if tab === 'vars'}
        <KvTable bind:rows={d.doc.variables} toggle={false} keyPlaceholder="Variable" />
        <p class="hint">
          Collection variables live in <code>postbote.yaml</code> and are committed. Lookup order for <code>{'{{name}}'}</code>: runtime
          <code>vars</code> → runner data row → active environment → folder variables → collection variables.
        </p>
      {:else if tab === 'headers'}
        <KvTable bind:rows={d.doc.headers} keyPlaceholder="Header" />
      {:else if tab === 'auth'}
        <AuthEditor bind:auth={d.doc.auth} allowInherit={false} />
      {:else if tab === 'scripts'}
        <ScriptsEditor bind:scripts={d.doc.scripts} />
        <p class="hint">Runs before/after every request of the collection (before folder and request scripts).</p>
      {:else if tab === 'cookies'}
        <p class="hint">Requests without an active environment use this jar; every environment has its own (see the environment).</p>
        <CookieJar env="" />
      {:else if tab === 'storage'}
        <h3>Git</h3>
        <label class="check">
          <input type="checkbox" bind:checked={d.doc.settings.commitEnvironments} />
          Commit all environments (also private <code>*.env</code> files)
        </label>
        <p class="hint">
          By default <code>.gitignore</code> excludes <code>*.env</code>; public environments (<code>*.env.pub</code>) are always
          committed. POSTBote only manages its own block in <code>.gitignore</code>.
        </p>
        {#if !gitignoreOk}
          <div class="row gap">
            <span class="pill warn">.gitignore is missing the POSTBote block</span>
            <button class="small" onclick={syncGitignore}>Add it</button>
          </div>
        {/if}
        <h3>Storage</h3>
        {#if app.ws.storage === 'disk'}
          <p>This collection is a folder on your disk: <code class="mono">{app.ws.path}</code></p>
          <p class="hint">Edit it with any tool or git; use “Reload” in the sidebar after external changes.</p>
        {:else if app.ws.storage === 'browser'}
          <p>Stored in this browser only (IndexedDB). The server does not keep a copy; it only executes runs in memory.</p>
          <div class="row gap">
            <button onclick={() => (app.exporting = true)}>Export as zip</button>
            {#if app.info.serverStorage}<button onclick={() => move('server')}>Store on server instead…</button>{/if}
          </div>
        {:else}
          <p>Stored on this server in your private space (opt-in).</p>
          <div class="row gap">
            <button onclick={() => (app.exporting = true)}>Export as zip</button>
            <button onclick={() => move('browser')}>Move to this browser</button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
