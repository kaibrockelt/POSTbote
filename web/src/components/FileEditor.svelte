<script>
  import CodeArea from './CodeArea.svelte';
  import { app, write } from '../lib/state.svelte.js';

  let { path } = $props();
  let text = $state(app.files[path] ?? '');
  let last = text;
  // follow external changes (run results, reload)
  $effect(() => {
    const t = app.files[path] ?? '';
    if (t !== last) {
      last = t;
      text = t;
    }
  });
  $effect(() => {
    if (text !== last) {
      last = text;
      write(path, text);
    }
  });
</script>

<div class="file-editor">
  <div class="muted mono path">{path}</div>
  <CodeArea bind:value={text} rows={28} />
</div>

<style>
  .file-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .path {
    font-size: 12px;
  }
</style>
