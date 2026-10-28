import { app, write } from './state.svelte.js';

/**
 * Binds an editable, parsed document to a collection file. Edits are written
 * back automatically; external changes (run results, reload) are re-parsed.
 * Opening a file never rewrites it, so formatting is only touched on edit.
 * Use inside a component that is keyed by `path`.
 */
export function fileDoc(path, parse, serialize) {
  const s = $state({ doc: null, error: null });
  let last = null;
  let skip = false;
  $effect(() => {
    const text = app.files[path] ?? '';
    if (text === last) return;
    last = text;
    const r = parse(text);
    skip = true;
    s.doc = r.doc;
    s.error = r.error;
  });
  $effect(() => {
    const snap = $state.snapshot(s.doc);
    if (skip) {
      skip = false;
      return;
    }
    if (!snap || s.error) return;
    const text = serialize(snap);
    if (text !== last) {
      last = text;
      write(path, text);
    }
  });
  return s;
}
