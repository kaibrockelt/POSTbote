<script>
  import { app, toast } from '../lib/state.svelte.js';
  import { effectiveRequest } from '../lib/effective.js';
  import { LANGUAGES, generate } from '../lib/snippets.js';

  let { path, doc, onclose } = $props();

  const remember = (k, fallback) => {
    try {
      return localStorage.getItem('postbote.snippet.' + k) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const store = (k, v) => {
    try {
      localStorage.setItem('postbote.snippet.' + k, v);
    } catch {
      /* storage unavailable */
    }
  };

  let lang = $state(remember('lang', 'curl'));
  let libs = $state(Object.fromEntries(LANGUAGES.map((l) => [l.id, remember('lib.' + l.id, l.libs[0].id)])));
  let resolve = $state(remember('resolve', 'true') === 'true');

  const current = $derived(LANGUAGES.find((l) => l.id === lang) || LANGUAGES[0]);
  const req = $derived(effectiveRequest(app.files, app.env, path, doc, { resolve }));
  const code = $derived(generate(current.id, libs[current.id], req));

  $effect(() => {
    store('lang', lang);
    store('resolve', String(resolve));
    for (const [k, v] of Object.entries(libs)) store('lib.' + k, v);
  });

  async function copy() {
    await navigator.clipboard.writeText(code);
    toast('Copied');
  }
  function onkeydown(e) {
    if (e.key === 'Escape') onclose();
  }
</script>

<svelte:window {onkeydown} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="modal code-modal">
    <div class="row between">
      <h3>Code</h3>
      <button class="icon" title="Close" onclick={onclose}>✕</button>
    </div>
    <div class="row gap wrap">
      <div class="seg">
        {#each LANGUAGES as l (l.id)}
          <button class:active={lang === l.id} onclick={() => (lang = l.id)}>{l.label}</button>
        {/each}
      </div>
      {#if current.libs.length > 1}
        <select bind:value={libs[current.id]}>
          {#each current.libs as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
        </select>
      {/if}
      <span class="grow"></span>
      <label class="check small"><input type="checkbox" bind:checked={resolve} /> Insert variable values</label>
      <button class="small primary" onclick={copy}>Copy</button>
    </div>
    <pre class="mono code">{code}</pre>
    {#if resolve && req.unresolved.length}
      <p class="hint warn">Not resolvable without running: {req.unresolved.join(', ')}</p>
    {/if}
    {#if req.scripted}
      <p class="hint">Pre-request scripts are not applied to snippets.</p>
    {/if}
    {#if resolve}
      <p class="hint">Values from the active environment are inserted. Turn this off before sharing snippets that would contain secrets.</p>
    {/if}
  </div>
</div>

<style>
  .code-modal {
    width: 860px;
    max-height: 90vh;
  }
  .wrap {
    flex-wrap: wrap;
  }
  .seg {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 7px;
    overflow: hidden;
  }
  .seg button {
    border: none;
    border-radius: 0;
    background: none;
    padding: 5px 12px;
  }
  .seg button + button {
    border-left: 1px solid var(--border);
  }
  .seg button.active {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .code {
    margin: 0;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    overflow: auto;
    max-height: 60vh;
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre;
  }
  .warn {
    color: var(--warn);
  }
</style>
