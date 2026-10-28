<script>
  import { api } from '../lib/api.js';
  import { init } from '../lib/state.svelte.js';

  let username = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(e) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      await api.login(username, password);
      await init();
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="center">
  <form class="modal login" onsubmit={submit}>
    <h2>POSTBote</h2>
    <p class="muted">Sign in to this team instance.</p>
    <input bind:value={username} placeholder="User name" autocomplete="username" />
    <input bind:value={password} type="password" placeholder="Password" autocomplete="current-password" />
    {#if error}<p class="err">{error}</p>{/if}
    <button class="primary" disabled={busy || !username || !password}>Sign in</button>
  </form>
</div>

<style>
  .center {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .login {
    width: 320px;
  }
  .err {
    color: var(--bad);
    margin: 0;
  }
</style>
