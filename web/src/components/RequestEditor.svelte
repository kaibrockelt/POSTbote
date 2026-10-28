<script>
  import Tabs from './Tabs.svelte';
  import KvTable from './KvTable.svelte';
  import CodeArea from './CodeArea.svelte';
  import AuthEditor from './AuthEditor.svelte';
  import ScriptsEditor from './ScriptsEditor.svelte';
  import ResponseView from './ResponseView.svelte';
  import FileEditor from './FileEditor.svelte';
  import VarField from './VarField.svelte';
  import CodeSnippets from './CodeSnippets.svelte';
  import { setContext } from 'svelte';
  import { variableScope } from '../lib/vars.js';
  import { effectiveRequest } from '../lib/effective.js';
  import { fileDoc } from '../lib/doc.svelte.js';
  import { parseRequest, serializeRequest, METHODS } from '../lib/format.js';
  import { app, run, cancelRun, currentFiles } from '../lib/state.svelte.js';

  let { path } = $props();
  const d = fileDoc(path, parseRequest, serializeRequest);
  let tab = $state('params');
  let showCode = $state(false);
  const scope = $derived(variableScope(currentFiles(), app.env, path));
  setContext('vars', () => scope);
  const resolvedUrl = $derived(d.doc ? effectiveRequest(currentFiles(), app.env, path, $state.snapshot(d.doc)).url : '');

  const running = $derived(!!app.running[path]);
  const result = $derived(app.results[path]?.request);
  const count = (l) => l?.filter((r) => r.key && !r.disabled).length || '';
  const tabs = $derived(
    d.doc
      ? [
          { id: 'params', label: 'Params', badge: count(d.doc.params) },
          { id: 'headers', label: 'Headers', badge: count(d.doc.headers) },
          { id: 'body', label: 'Body', badge: d.doc.body.type !== 'none' ? d.doc.body.type : '' },
          { id: 'auth', label: 'Auth', badge: d.doc.auth.type !== 'inherit' ? d.doc.auth.type : '' },
          { id: 'scripts', label: 'Scripts', badge: (d.doc.scripts.pre ? 1 : 0) + (d.doc.scripts.post ? 1 : 0) || '' },
          { id: 'docs', label: 'Docs' },
        ]
      : [],
  );

  function send() {
    if (running) cancelRun(path);
    else run('request', path);
  }

  // pasting a URL with a query string moves it into the params table
  function onpaste(e) {
    const text = e.clipboardData.getData('text');
    if (!/^\s*https?:\/\/\S+\?\S+/.test(text) || d.doc.url) return;
    e.preventDefault();
    const [base, q] = text.trim().split(/\?(.*)/s);
    d.doc.url = base;
    for (const part of q.split('&').filter(Boolean)) {
      const [k, v = ''] = part.split(/=(.*)/s);
      const dec = (s) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      d.doc.params.push({ key: dec(k), value: dec(v), file: '', disabled: false });
    }
  }
</script>


{#if showCode && d.doc}
  <CodeSnippets {path} doc={$state.snapshot(d.doc)} onclose={() => (showCode = false)} />
{/if}

{#if d.error}
  <div class="error-box">Cannot parse this request: {d.error}</div>
  <FileEditor {path} />
{:else if d.doc}
  <div class="request">
    <div class="editor-pane">
      <input class="title" bind:value={d.doc.name} placeholder="Request name" />
      <div class="urlbar">
        <select class="method m-{d.doc.method}" bind:value={d.doc.method}>
          {#each METHODS as m}<option>{m}</option>{/each}
        </select>
        <VarField class="url mono grow" bind:value={d.doc.url} placeholder={'{{baseUrl}}/path'} {onpaste} />
        <button title="Generate code (cURL, PHP, Node.js, Python)" onclick={() => (showCode = true)}>&lt;/&gt; Code</button>
        <button class="primary" onclick={send}>{running ? 'Cancel' : 'Send'}</button>
      </div>
      {#if resolvedUrl && resolvedUrl !== d.doc.url}
        <div class="resolved mono" title="URL with the active environment applied">→ {resolvedUrl}</div>
      {/if}
      <Tabs {tabs} bind:active={tab} />
      <div class="tab-body">
        {#if tab === 'params'}
          <KvTable bind:rows={d.doc.params} keyPlaceholder="Query parameter" />
          <p class="hint">Parameters are URL-encoded and appended to the URL. Use <code>{'{{var}}'}</code> anywhere.</p>
        {:else if tab === 'headers'}
          <KvTable bind:rows={d.doc.headers} keyPlaceholder="Header" />
          <p class="hint">Collection and folder headers are inherited; a header with the same name here overrides them.</p>
        {:else if tab === 'body'}
          <div class="row body-types">
            {#each ['none', 'json', 'graphql', 'text', 'xml', 'form', 'multipart', 'file'] as t}
              <label class="check"><input type="radio" bind:group={d.doc.body.type} value={t} /> {t}</label>
            {/each}
          </div>
          {#if d.doc.body.type === 'form' || d.doc.body.type === 'multipart'}
            <KvTable bind:rows={d.doc.body.fields} withFile={d.doc.body.type === 'multipart'} keyPlaceholder="Field" />
          {:else if d.doc.body.type === 'file'}
            <VarField class="mono" bind:value={d.doc.body.file} placeholder="data/upload.png" />
            <p class="hint">
              A file inside the collection folder, sent as the raw body (binary files are fine). Content-Type follows the extension unless you set the header.
            </p>
          {:else if d.doc.body.type === 'graphql'}
            <div class="gql">
              <div class="gql-part">
                <span class="muted small">Query</span>
                <VarField class="mono" multiline bind:value={d.doc.body.content} rows={12} placeholder={'query Users($limit: Int) {\n  users(limit: $limit) { id name }\n}'} />
              </div>
              <div class="gql-part">
                <span class="muted small">Variables (JSON)</span>
                <VarField class="mono" multiline bind:value={d.doc.body.variables} rows={12} placeholder={'{\n  "limit": 10\n}'} />
              </div>
            </div>
            <p class="hint">Sent as JSON <code>{'{ "query", "variables" }'}</code> with Content-Type application/json; usually with method POST.</p>
          {:else if d.doc.body.type !== 'none'}
            <VarField class="mono" multiline bind:value={d.doc.body.content} rows={14} placeholder={d.doc.body.type === 'json' ? '{\n  "name": "{{name}}"\n}' : ''} />
          {/if}
        {:else if tab === 'auth'}
          <AuthEditor bind:auth={d.doc.auth} />
        {:else if tab === 'scripts'}
          <ScriptsEditor bind:scripts={d.doc.scripts} />
        {:else if tab === 'docs'}
          <CodeArea bind:value={d.doc.docs} rows={12} placeholder="Markdown documentation for this request" />
        {/if}
      </div>
    </div>
    <div class="response-pane">
      <ResponseView {result} />
    </div>
  </div>
{/if}

<style>
  .request {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 18px;
    height: 100%;
    min-height: 0;
  }
  @media (max-width: 1150px) {
    .request {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(320px, 1fr);
      height: auto;
    }
  }
  .editor-pane,
  .response-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 8px;
  }
  .editor-pane {
    overflow: auto;
  }
  .response-pane {
    border-left: 1px solid var(--border);
    padding-left: 18px;
  }
  @media (max-width: 1150px) {
    .response-pane {
      border-left: none;
      padding-left: 0;
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }
  }
  .urlbar {
    display: flex;
    gap: 6px;
  }
  .resolved {
    font-size: 11.5px;
    color: var(--fg-3);
    margin: -2px 0 0 108px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .method {
    font-weight: 600;
    width: 100px;
  }
  .tab-body {
    padding: 8px 0;
  }
  .gql {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 10px;
  }
  .gql-part {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .body-types {
    gap: 14px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
</style>
