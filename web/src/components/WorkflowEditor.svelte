<script>
  import Tabs from './Tabs.svelte';
  import ScriptsEditor from './ScriptsEditor.svelte';
  import CodeArea from './CodeArea.svelte';
  import FileEditor from './FileEditor.svelte';
  import WorkflowResult from './WorkflowResult.svelte';
  import { fileDoc } from '../lib/doc.svelte.js';
  import { parseWorkflow, serializeWorkflow } from '../lib/format.js';
  import { allRequests } from '../lib/tree.js';
  import { app, run, cancelRun, select, ask, write, contentOf, setDraft, saveFile, isDirty, confirmAction, toast } from '../lib/state.svelte.js';

  let { path } = $props();
  const d = fileDoc(path, parseWorkflow, serializeWorkflow);
  let tab = $state('steps');
  let open = $state({});

  const requests = $derived(allRequests(app.files));
  // data files live in data/ only; the runner refuses anything else
  const DATA_FILE = /^data\/.+\.(csv|tsv|json)$/;
  const dataFiles = $derived(Object.keys(app.files).filter((p) => DATA_FILE.test(p)).sort());
  const running = $derived(!!app.running[path]);
  const result = $derived(app.results[path]?.workflow);

  // show the result as soon as a run starts (button or Cmd/Ctrl+Enter)
  $effect(() => {
    if (running) tab = 'result';
  });

  // Data editor: with a file chosen it edits that file's draft (runs use it);
  // without one it is a scratch buffer that can be saved as a new file.
  const file = $derived(d.doc?.data && d.doc.data in app.files ? d.doc.data : '');
  const scratch = $derived(app.dataScratch[path] || '');
  const dataText = $derived(file ? contentOf(file) : scratch);
  const dataDirty = $derived(!!file && isDirty(file));
  function editData(text) {
    if (file) setDraft(file, text);
    else app.dataScratch[path] = text;
  }

  async function saveNewDataFile() {
    const base = (d.doc.name || 'rows').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rows';
    let p = await ask('Save data as new file', `data/${base}.csv`, { hint: 'In the data/ folder: CSV/TSV with a header row, or a JSON array of objects.' });
    if (!p) return;
    p = p.trim().replace(/^\/+/, '');
    if (!p.startsWith('data/')) p = `data/${p}`;
    if (!DATA_FILE.test(p)) return toast('Use a .csv, .tsv or .json file name', 'error');
    if (p in app.files && !(await confirmAction(`Overwrite ${p}?`, 'A data file with this name exists.', 'Overwrite'))) return;
    const text = dataText;
    if (file) setDraft(file, app.files[file]); // the chosen file keeps its saved content
    write(p, text);
    delete app.dataScratch[path];
    d.doc.data = p;
  }

  function overwriteDataFile() {
    saveFile(file);
    toast(`Saved ${file}`);
  }

  function addStep() {
    const n = d.doc.steps.length + 1;
    d.doc.steps.push({ name: `step-${n}`, request: requests[0]?.path || '', if: '', scripts: { pre: '', post: '' } });
  }
  function moveStep(i, dir) {
    const s = d.doc.steps;
    const j = i + dir;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
  }
</script>

{#if d.error}
  <div class="error-box">Cannot parse this runner: {d.error}</div>
  <FileEditor {path} />
{:else if d.doc}
  <div class="page">
    <div class="row between">
      <input class="title grow" bind:value={d.doc.name} placeholder="Runner name" />
      <button class="primary" onclick={() => (running ? cancelRun(path) : run('workflow', path))}>{running ? 'Cancel' : '▶ Run'}</button>
    </div>
    <Tabs
      tabs={[
        { id: 'steps', label: 'Steps', badge: d.doc.steps.length },
        { id: 'data', label: 'Data & settings' },
        { id: 'scripts', label: 'Runner scripts' },
        { id: 'result', label: 'Result', badge: result ? `${result.passed}/${result.passed + result.failed}` : '', badgeKind: result?.failed || result?.error ? 'bad' : 'ok' },
      ]}
      bind:active={tab}
    />
    <div class="tab-body">
      {#if tab === 'steps'}
        <div class="steps">
          {#each d.doc.steps as step, i (i)}
            <div class="step card">
              <div class="row gap">
                <span class="num">{i + 1}</span>
                <input class="mono name" bind:value={step.name} placeholder="step name (for wf.goto)" />
                <select class="grow" bind:value={step.request}>
                  {#if step.request && !requests.some((r) => r.path === step.request)}<option value={step.request}>⚠ {step.request}</option>{/if}
                  {#each requests as r}<option value={r.path}>{r.method} · {r.name} — {r.path.slice(9)}</option>{/each}
                </select>
                <button class="icon" title="Open request" onclick={() => select({ kind: 'request', path: step.request })} disabled={!step.request}>↗</button>
                <button class="icon" title="Move up" onclick={() => moveStep(i, -1)}>↑</button>
                <button class="icon" title="Move down" onclick={() => moveStep(i, 1)}>↓</button>
                <button class="icon" title="Remove step" onclick={() => d.doc.steps.splice(i, 1)}>✕</button>
              </div>
              <div class="row gap">
                <span class="muted small">if</span>
                <input class="mono grow" bind:value={step.if} placeholder="optional condition, e.g. vars.get('token') !== undefined" />
                <button class="link" onclick={() => (open[i] = !open[i])}>
                  {open[i] ? 'Hide' : 'Step scripts'}{step.scripts.pre || step.scripts.post ? ' •' : ''}
                </button>
              </div>
              {#if open[i]}
                <div class="step-scripts">
                  <span class="muted small">Pre (after the request's own pre-scripts)</span>
                  <CodeArea bind:value={step.scripts.pre} rows={4} />
                  <span class="muted small">Post (after the request's own post-scripts) — e.g. <code>wf.goto('step')</code>, <code>wf.stop()</code></span>
                  <CodeArea bind:value={step.scripts.post} rows={5} />
                </div>
              {/if}
            </div>
          {/each}
          <button onclick={addStep} disabled={!requests.length}>+ Add step</button>
          {#if !requests.length}<p class="hint">Create a request first.</p>{/if}
        </div>
      {:else if tab === 'data'}
        <div class="form">
          <label>
            <span>Data file <span class="muted">(from <code>data/</code>)</span></span>
            <select bind:value={d.doc.data}>
              <option value="">— no file —</option>
              {#if d.doc.data && !file}<option value={d.doc.data}>⚠ {d.doc.data} (missing)</option>{/if}
              {#each dataFiles as f}<option value={f}>{f}</option>{/each}
            </select>
          </label>
          <CodeArea bind:value={() => dataText, editData} rows={14} placeholder={'name,email\nada,ada@example.com'} />
          <div class="row gap">
            <button class="small" onclick={saveNewDataFile} disabled={!dataText.trim()}>Save as new file…</button>
            <button class="small" onclick={overwriteDataFile} disabled={!file} title={file ? `Write the editor content to ${file}` : 'Choose a data file first'}>Overwrite file</button>
            {#if dataDirty}<span class="muted small">unsaved changes – runs use them</span>
            {:else if !file && scratch.trim()}<span class="muted small">not saved – runs use it anyway</span>{/if}
          </div>
          <p class="hint">
            Runs always use the editor content. Every row of a CSV/TSV (with header) or JSON array runs all steps once; an empty editor
            means a single iteration. Row fields are available as <code>{'{{field}}'}</code> and
            <code>wf.row</code>. A pre-run script can also set <code>wf.rows</code> itself.
          </p>
          <label class="check"><input type="checkbox" bind:checked={d.doc.settings.stopOnFailure} /> Stop on the first failed step</label>
          <label><span>Delay between steps (ms)</span><input type="number" min="0" bind:value={d.doc.settings.delayMs} /></label>
          <label><span>Max iterations</span><input type="number" min="0" bind:value={d.doc.settings.maxIterations} placeholder="all rows" /></label>
        </div>
      {:else if tab === 'scripts'}
        <ScriptsEditor bind:scripts={d.doc.scripts} preLabel="Pre-run (once, before the first iteration)" postLabel="Post-run (once, after all iterations)" context="workflow" />
      {:else if tab === 'result'}
        {#if result}<WorkflowResult {result} />{:else}<p class="muted">Not run yet.</p>{/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .steps {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 1000px;
  }
  .step {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .num {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--bg-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    flex-shrink: 0;
  }
  .name {
    width: 180px;
  }
  .step-scripts {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
