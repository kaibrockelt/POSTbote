<script>
  import CodeArea from './CodeArea.svelte';
  import { contentOf, setDraft } from '../lib/state.svelte.js';

  let { path } = $props();
  let text = $state(contentOf(path));
  let last = text;
  // follow external changes (run results, reload)
  $effect(() => {
    const t = contentOf(path);
    if (t !== last) {
      last = t;
      text = t;
    }
  });
  $effect(() => {
    if (text !== last) {
      last = text;
      setDraft(path, text);
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
