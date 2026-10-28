import { app, contentOf, setDraft } from './state.svelte.js';

/**
 * Binds an editable, parsed document to a collection file. Edits go into the
 * file's draft (saved explicitly); external changes (run results, reload,
 * discard) are re-parsed. Opening a file never changes it, so formatting is
 * only touched on edit. Use inside a component that is keyed by `path`.
 */
export function fileDoc(path, parse, serialize) {
  const s = $state({ doc: null, error: null });
  let last = null;
  let skip = false;
  $effect(() => {
    const text = contentOf(path);
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
      // edited back to the saved state (modulo formatting) -> no longer dirty
      const saved = app.files[path] ?? '';
      const savedDoc = parse(saved).doc;
      setDraft(path, savedDoc && serialize(savedDoc) === text ? saved : text);
    }
  });
  return s;
}
