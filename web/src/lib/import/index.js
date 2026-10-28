// Importers turn foreign formats into POSTBote docs. Every format lives in
// its own module (and git branch) and registers here:
//
// - request importers: text pasted into "New request" → one request doc
//     { id, label, detect(text) → bool, parse(text) → { doc, warnings } }
// - collection importers: a file in "Add a collection" → a new collection
//     { id, label, accept, detect(text, fileName) → bool,
//       parse(text, fileName) → { name, files, warnings } }
//
// Docs use the shapes of parseRequest()/parseFolder() in format.js, so the
// one serializer there writes the files.

export const requestImporters = [];
export const collectionImporters = [];

/** Recognises the pasted text and converts it, or throws with a helpful message. */
export function importRequest(text) {
  const t = String(text || '').trim();
  const imp = requestImporters.find((i) => i.detect(t));
  if (!imp) throw new Error(`Unrecognised format. Supported: ${requestImporters.map((i) => i.label).join(', ')}.`);
  const { doc, warnings = [] } = imp.parse(t);
  return { format: imp.label, doc, warnings };
}

export function importCollection(text, fileName = '') {
  const imp = collectionImporters.find((i) => i.detect(text, fileName));
  if (!imp) throw new Error(`Unrecognised file. Supported: ${collectionImporters.map((i) => i.label).join(', ')}.`);
  const { name, files, warnings = [] } = imp.parse(text, fileName);
  return { format: imp.label, name, files, warnings };
}

/** Request name from method and URL path, e.g. "GET users/{id}". */
export function nameFromUrl(method, url) {
  let path = String(url || '').replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/^\{\{[^}]+\}\}/, '');
  path = path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  return `${method || 'GET'} ${path || '/'}`.slice(0, 80);
}
