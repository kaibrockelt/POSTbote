<script>
  // Zip export of the saved collection. Environments are excluded unless
  // chosen; private values (secrets) need a second, explicit opt-in.
  import { app, exportWorkspace, fail, toast } from '../lib/state.svelte.js';
  import { listEnvs, isEnvFile, envName, isPublicEnv } from '../lib/format.js';

  let { onclose } = $props();
  const envs = listEnvs(app.files);
  let env = $state(''); // '' = none, '*' = all, or a name
  let withPrivate = $state(false);
  let busy = $state(false);

  const chosen = (name) => env === '*' || env === name;
  const files = $derived(
    Object.fromEntries(
      Object.entries($state.snapshot(app.files)).filter(([p]) => {
        if (!isEnvFile(p)) return true;
        if (!chosen(envName(p))) return false;
        return isPublicEnv(p) || withPrivate;
      }),
    ),
  );
  const privateAvailable = $derived(envs.some((e) => chosen(e.name) && e.priv));
  const envFiles = $derived(Object.keys(files).filter(isEnvFile));
  const unsaved = Object.keys(app.drafts).length;

  $effect(() => {
    if (!env) withPrivate = false;
  });

  async function submit(e) {
    e.preventDefault();
    busy = true;
    try {
      const saved = await exportWorkspace($state.snapshot(files));
      if (saved) toast(`Exported to ${saved}`);
      onclose();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <form class="modal" onsubmit={submit}>
    <h3>Export “{app.ws.name}” as zip</h3>

    <label class="field">
      <span>Include environments</span>
      <select bind:value={env}>
        <option value="">None</option>
        {#if envs.length > 1}<option value="*">All environments</option>{/if}
        {#each envs as e (e.name)}<option value={e.name}>{e.name}</option>{/each}
      </select>
    </label>

    {#if env}
      <label class="check" class:disabled={!privateAvailable}>
        <input type="checkbox" bind:checked={withPrivate} disabled={!privateAvailable} />
        Include private values (secrets from <code>*.env</code>)
      </label>
      {#if withPrivate}
        <p class="warning">The archive will contain secrets. Only share it through a trusted channel.</p>
      {:else}
        <p class="hint">Only shared values (<code>*.env.pub</code>) are exported; recipients add their own secrets.</p>
      {/if}
    {/if}

    <p class="hint">
      {Object.keys(files).length} files{envFiles.length ? `, environments: ${envFiles.map((p) => p.split('/').pop()).join(', ')}` : ', no environments'}.
      {#if unsaved}Unsaved changes ({unsaved}) are not included.{/if}
    </p>

    <div class="row end gap">
      <button type="button" onclick={onclose}>Cancel</button>
      <button type="submit" class="primary" disabled={busy}>Export</button>
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
  .warning {
    margin: 0;
    color: var(--bad);
    background: var(--bad-bg);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12.5px;
  }
  .disabled {
    opacity: 0.5;
  }
</style>
