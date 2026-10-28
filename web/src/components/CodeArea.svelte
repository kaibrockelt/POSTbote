<script>
  let { value = $bindable(''), placeholder = '', rows = 8, readonly = false } = $props();

  // Tab indents instead of leaving the field; Shift+Tab outdents.
  function onkeydown(e) {
    if (e.key !== 'Tab' || readonly) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = ta;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    if (e.shiftKey) {
      if (value.startsWith('  ', lineStart)) {
        value = value.slice(0, lineStart) + value.slice(lineStart + 2);
        requestAnimationFrame(() => ta.setSelectionRange(Math.max(lineStart, s - 2), Math.max(lineStart, end - 2)));
      }
      return;
    }
    value = value.slice(0, s) + '  ' + value.slice(end);
    requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
  }
</script>

<textarea class="code mono" bind:value {placeholder} {rows} {readonly} {onkeydown} spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>

<style>
  .code {
    width: 100%;
    resize: vertical;
    tab-size: 2;
    line-height: 1.45;
    white-space: pre;
    overflow: auto;
  }
</style>
