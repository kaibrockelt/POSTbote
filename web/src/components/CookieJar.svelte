<script>
  // Cookies the runner kept for one environment (.cookies/<env>.json, never
  // committed). They are sent again by later requests until removed here.
  import { app, write, removeFile, fail } from '../lib/state.svelte.js';

  let { env = '' } = $props();
  const path = $derived(`.cookies/${env || '_none'}.json`);
  let masked = $state(true);

  const entries = $derived.by(() => {
    try {
      const list = JSON.parse(app.files[path] || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  });
  const view = (c) => {
    const [pair, ...attrs] = String(c.raw_cookie || '').split(';');
    const i = pair.indexOf('=');
    const domain = c.domain?.HostOnly ?? c.domain?.Suffix ?? '';
    const expires = c.expires?.AtUtc ? new Date(c.expires.AtUtc).toLocaleString() : 'session';
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain, path: Array.isArray(c.path) ? c.path[0] : '/', expires, flags: attrs.map((a) => a.trim().split('=')[0]).filter((a) => /^(httponly|secure)$/i.test(a)) };
  };

  function remove(i) {
    const next = entries.filter((_, j) => j !== i);
    (next.length ? Promise.resolve(write(path, JSON.stringify(next, null, 2) + '\n')) : removeFile(path)).catch(fail);
  }
  const clear = () => removeFile(path).catch(fail);
</script>

<section class="cookies">
  <div class="row between">
    <h3>Cookies <span class="file mono">{path}</span></h3>
    <div class="row gap">
      {#if entries.length}
        <label class="check small"><input type="checkbox" bind:checked={masked} /> hide values</label>
        <button class="small" onclick={clear}>Clear all</button>
      {/if}
      <span class="pill ok">gitignored</span>
    </div>
  </div>
  <p class="hint">Cookies set by responses are kept per environment and sent again by later requests. Scripts: <code>cookies.get(name)</code>, <code>cookies.set(name, value, url)</code>, <code>cookies.clear()</code>.</p>
  {#if entries.length}
    <table class="grid mono">
      <tbody>
        {#each entries.map(view) as c, i (i)}
          <tr>
            <td>{c.name}</td>
            <td class="value">{masked ? '••••••' : c.value}</td>
            <td class="muted">{c.domain}{c.path}</td>
            <td class="muted">{c.expires}{c.flags.length ? ` · ${c.flags.join(', ')}` : ''}</td>
            <td><button class="icon" title="Remove cookie" onclick={() => remove(i)}>✕</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="muted">No cookies yet.</p>
  {/if}
</section>

<style>
  .cookies {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  h3 {
    margin: 0;
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .file {
    font-weight: normal;
    font-size: 11.5px;
    color: var(--fg-3);
  }
  .hint {
    margin: 0 0 4px;
  }
  .value {
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
