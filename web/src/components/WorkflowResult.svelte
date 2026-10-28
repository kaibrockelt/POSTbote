<script>
  import ResponseView from './ResponseView.svelte';
  import { statusKind } from '../lib/highlight.js';

  let { result } = $props();
  let openKey = $state(null);

  const failedStep = (r) => r && (r.error || r.scriptErrors?.length || r.tests?.some((t) => !t.passed));
</script>

<div class="wf-result">
  <div class="row gap summary">
    <span class="pill {result.failed || result.error || result.scriptErrors?.length ? 'bad' : 'ok'}">
      {result.passed} passed · {result.failed} failed
    </span>
    <span class="muted">{result.iterations.length} iteration{result.iterations.length === 1 ? '' : 's'} · {result.durationMs} ms</span>
    {#if result.stopped}<span class="pill warn">stopped: {result.stopped}</span>{/if}
  </div>
  {#if result.error}<div class="error-box">{result.error}</div>{/if}
  {#each result.scriptErrors || [] as e}<pre class="error-box mono">{e}</pre>{/each}
  {#each result.logs as l}<pre class="log mono"><span class="muted">{l.source}</span> {l.message}</pre>{/each}
  {#each result.tests as t}<div class="test" class:bad={!t.passed}>{t.passed ? '✔' : '✘'} {t.name} {t.error || ''}</div>{/each}

  {#each result.iterations as it}
    <div class="iteration">
      <div class="it-head">
        Iteration {it.index + 1}
        {#if it.row}<span class="mono muted small">{JSON.stringify(it.row)}</span>{/if}
      </div>
      {#each it.steps as s, si}
        {@const key = `${it.index}-${si}`}
        {@const r = s.result}
        <button class="step-row" class:bad={failedStep(r)} onclick={() => (openKey = openKey === key ? null : key)} disabled={s.skipped}>
          <span class="icon">{s.skipped ? '–' : failedStep(r) ? '✘' : '✔'}</span>
          <span class="mono">{s.step}</span>
          {#if s.skipped}
            <span class="muted small">skipped: {s.reason}</span>
          {:else if r.response}
            <span class="pill small {statusKind(r.response.status)}">{r.response.status}</span>
            <span class="muted small">{r.request?.method} {r.request?.url}</span>
            <span class="grow"></span>
            {#if r.tests.length}<span class="small">{r.tests.filter((t) => t.passed).length}/{r.tests.length} tests</span>{/if}
            <span class="muted small">{r.response.timeMs} ms</span>
          {:else}
            <span class="small err">{r.error}</span>
          {/if}
        </button>
        {#if openKey === key && r}
          <div class="detail"><ResponseView result={r} compact /></div>
        {/if}
      {/each}
    </div>
  {/each}
</div>

<style>
  .wf-result {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .iteration {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .it-head {
    background: var(--bg-2);
    padding: 6px 10px;
    font-weight: 600;
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .step-row {
    display: flex;
    gap: 10px;
    align-items: center;
    width: 100%;
    border: none;
    border-top: 1px solid var(--border);
    border-radius: 0;
    background: none;
    text-align: left;
    padding: 6px 10px;
    color: var(--ok);
  }
  .step-row:disabled {
    color: var(--fg-3);
    cursor: default;
  }
  .step-row.bad {
    color: var(--bad);
  }
  .step-row span:not(.icon):not(.pill) {
    color: var(--fg);
  }
  .step-row .muted {
    color: var(--fg-3) !important;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    padding: 4px 12px 12px;
    border-top: 1px dashed var(--border);
  }
  .test {
    color: var(--ok);
  }
  .test.bad,
  .err {
    color: var(--bad) !important;
  }
  .log {
    margin: 0;
    font-size: 12px;
    white-space: pre-wrap;
  }
</style>
