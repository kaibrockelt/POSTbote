<script>
  import VarField from './VarField.svelte';
  let { auth = $bindable(), allowInherit = true } = $props();
  const types = [
    ...(allowInherit ? [['inherit', 'Inherit from parent']] : []),
    ['none', 'No auth'],
    ['bearer', 'Bearer token'],
    ['basic', 'Basic auth'],
    ['apikey', 'API key'],
  ];
</script>

<div class="form">
  <label>
    <span>Type</span>
    <select bind:value={auth.type}>
      {#each types as [v, l]}<option value={v}>{l}</option>{/each}
    </select>
  </label>
  {#if auth.type === 'bearer'}
    <label><span>Token</span><VarField class="mono" bind:value={auth.token} placeholder={'{{token}}'} /></label>
  {:else if auth.type === 'basic'}
    <label><span>Username</span><VarField class="mono" bind:value={auth.username} /></label>
    <label><span>Password</span><VarField class="mono" bind:value={auth.password} placeholder={'{{password}}'} /></label>
  {:else if auth.type === 'apikey'}
    <label><span>Name</span><VarField class="mono" bind:value={auth.key} placeholder="X-API-Key" /></label>
    <label><span>Value</span><VarField class="mono" bind:value={auth.value} placeholder={'{{apiKey}}'} /></label>
    <label>
      <span>Send as</span>
      <select bind:value={auth.in}><option value="header">Header</option><option value="query">Query parameter</option></select>
    </label>
  {/if}
  <p class="hint">
    Secrets belong in a private environment (<code>*.env</code>) and are referenced as <code>{'{{name}}'}</code>, so they never end up in git.
  </p>
</div>
