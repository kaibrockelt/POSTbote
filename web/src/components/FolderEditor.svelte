<script>
  import Tabs from './Tabs.svelte';
  import KvTable from './KvTable.svelte';
  import AuthEditor from './AuthEditor.svelte';
  import ScriptsEditor from './ScriptsEditor.svelte';
  import FileEditor from './FileEditor.svelte';
  import { setContext } from 'svelte';
  import { variableScope } from '../lib/vars.js';
  import { fileDoc } from '../lib/doc.svelte.js';
  import { parseFolder, serializeFolder, FOLDER_FILE } from '../lib/format.js';
  import { app, currentFiles } from '../lib/state.svelte.js';

  let { path } = $props(); // folder directory
  const file = `${path}/${FOLDER_FILE}`;
  const d = fileDoc(file, parseFolder, serializeFolder);
  const scope = $derived(variableScope(currentFiles(), app.env, file));
  setContext('vars', () => scope);
  let tab = $state('headers');
</script>

{#if d.error}
  <div class="error-box">Cannot parse {file}: {d.error}</div>
  <FileEditor path={file} />
{:else if d.doc}
  <div class="page">
    <div class="muted mono small">{path}/</div>
    <input class="title" bind:value={d.doc.name} placeholder={path.split('/').pop()} />
    <p class="hint">Settings here apply to every request in this folder and its subfolders.</p>
    <Tabs
      tabs={[
        { id: 'headers', label: 'Headers' },
        { id: 'vars', label: 'Variables' },
        { id: 'auth', label: 'Auth' },
        { id: 'scripts', label: 'Scripts' },
      ]}
      bind:active={tab}
    />
    <div class="tab-body">
      {#if tab === 'headers'}
        <KvTable bind:rows={d.doc.headers} keyPlaceholder="Header" />
      {:else if tab === 'vars'}
        <KvTable bind:rows={d.doc.variables} toggle={false} keyPlaceholder="Variable" />
        <p class="hint">Folder variables are committed. Put secrets into a private environment instead.</p>
      {:else if tab === 'auth'}
        <AuthEditor bind:auth={d.doc.auth} />
      {:else if tab === 'scripts'}
        <ScriptsEditor bind:scripts={d.doc.scripts} />
      {/if}
    </div>
  </div>
{/if}
