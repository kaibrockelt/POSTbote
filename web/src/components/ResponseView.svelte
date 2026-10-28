<script>
  import Tabs from './Tabs.svelte';
  import { highlightJson, prettyBody, formatSize, statusKind } from '../lib/highlight.js';
  import { toast } from '../lib/state.svelte.js';

  let { result, compact = false } = $props();
  let tab = $state('body');
  let raw = $state(false);

  const res = $derived(result?.response);
  const contentType = $derived(res?.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '');
  const pretty = $derived(res && !res.encoding ? prettyBody(res.body, contentType) : null);
  const failed = $derived(result?.tests?.filter((t) => !t.passed).length || 0);
  const isImage = $derived(res?.encoding === 'base64' && contentType.startsWith('image/'));

  const tabs = $derived([
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers', badge: res?.headers?.length || '' },
    {
      id: 'tests',
      label: 'Tests',
      badge: result?.tests?.length ? `${result.tests.length - failed}/${result.tests.length}` : '',
      badgeKind: failed ? 'bad' : 'ok',
    },
    { id: 'console', label: 'Console', badge: result?.logs?.length || '' },
    { id: 'request', label: 'Sent request' },
  ]);

  // jump to the console/tests once per new result when something failed
  let seen = null;
  $effect(() => {
    const r = result;
    if (!r || r === seen) return;
    seen = r;
    if (r.scriptErrors?.length) tab = 'console';
    else if (r.tests?.some((t) => !t.passed)) tab = 'tests';
    else if (!r.response && r.error) tab = 'request';
  });

  async function copy() {
    await navigator.clipboard.writeText(raw || !pretty ? res.body : pretty.text);
    toast('Copied');
  }
</script>

<div class="response" class:compact>
  {#if result}
    <div class="status-line">
      {#if res}
        <span class="pill {statusKind(res.status)}">{res.status} {res.statusText}</span>
        <span class="muted">{res.timeMs} ms</span>
        <span class="muted">{formatSize(res.size)}{res.truncated ? ' (truncated)' : ''}</span>
      {/if}
      {#if result.error}<span class="pill bad">{result.error}</span>{/if}
    </div>
    <Tabs {tabs} bind:active={tab} />
    <div class="pane">
      {#if tab === 'body'}
        {#if res}
          <div class="row tools">
            {#if pretty?.json}<label class="check"><input type="checkbox" bind:checked={raw} /> raw</label>{/if}
            <span class="muted mono">{contentType}</span>
            <span class="grow"></span>
            {#if !res.encoding}<button class="small" onclick={copy}>Copy</button>{/if}
          </div>
          {#if isImage}
            <img alt="response" src={`data:${contentType};base64,${res.body}`} />
          {:else if res.encoding}
            <p class="muted">Binary response ({formatSize(res.size)}), not shown.</p>
          {:else if pretty.json && !raw}
            <pre class="body mono">{@html highlightJson(pretty.text)}</pre>
          {:else}
            <pre class="body mono">{res.body}</pre>
          {/if}
        {:else}
          <p class="muted">No response.</p>
        {/if}
      {:else if tab === 'headers'}
        <table class="grid mono">
          <tbody>
            {#each res?.headers || [] as [k, v]}<tr><td>{k}</td><td>{v}</td></tr>{/each}
          </tbody>
        </table>
      {:else if tab === 'tests'}
        {#each result.tests as t}
          <div class="test" class:bad={!t.passed}>
            <span>{t.passed ? '✔' : '✘'}</span>
            <span>{t.name}</span>
            {#if t.error}<span class="mono err">{t.error}</span>{/if}
          </div>
        {:else}
          <p class="muted">No tests. Add <code>test('name', () =&gt; expect(res.status).toBe(200))</code> to a post-response script.</p>
        {/each}
      {:else if tab === 'console'}
        {#each result.scriptErrors || [] as e}<pre class="log error mono">{e}</pre>{/each}
        {#each result.logs as l}
          <pre class="log {l.level} mono"><span class="src">{l.source}</span>{l.message}</pre>
        {:else}
          {#if !result.scriptErrors?.length}<p class="muted">No console output.</p>{/if}
        {/each}
      {:else if tab === 'request'}
        {#if result.request}
          <pre class="body mono"><b>{result.request.method}</b> {result.request.url}
{#each result.request.headers as [k, v]}{k}: {v}
{/each}{#if result.request.body}
{result.request.body}{/if}</pre>
        {:else}
          <p class="muted">The request was not sent.</p>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="empty muted">Send the request to see the response here.<br /><kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd></div>
  {/if}
</div>

<style>
  .response {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }
  .status-line {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 0;
    flex-wrap: wrap;
  }
  .pane {
    flex: 1;
    overflow: auto;
    padding-top: 8px;
    min-height: 0;
  }
  .compact .pane {
    max-height: 420px;
  }
  .tools {
    gap: 10px;
    margin-bottom: 6px;
    font-size: 12px;
  }
  .body {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12.5px;
  }
  img {
    max-width: 100%;
  }
  .test {
    display: flex;
    gap: 8px;
    padding: 4px 0;
    color: var(--ok);
    align-items: baseline;
  }
  .test.bad {
    color: var(--bad);
  }
  .test .err {
    color: var(--fg-2);
    font-size: 12px;
  }
  .log {
    margin: 0 0 4px;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
    padding: 3px 6px;
    border-left: 3px solid var(--border);
  }
  .log.warn {
    border-color: var(--warn);
  }
  .log.error {
    border-color: var(--bad);
    color: var(--bad);
  }
  .src {
    color: var(--fg-3);
    margin-right: 8px;
  }
  .empty {
    margin: auto;
    text-align: center;
    line-height: 2;
  }
</style>
