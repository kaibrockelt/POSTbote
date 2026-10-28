// Importers turn foreign formats into POSTBote docs. Every format lives in
// its own module (and git branch) and registers here:
//
// - request importers: text pasted into "New request" → one request doc
//     { id, label, detect(text) → bool, parse(text) → { doc, warnings } }
// - collection importers: files chosen in "Add a collection" → a new collection
//     { id, label, accept: ['.json'], detect(input) → bool,
//       parse(inputs) → result (see build.js) }
//     inputs: [{ name, text, json? }] – one collection plus e.g. environments;
//     `json` is the parsed JSON or YAML document (undefined if neither)
//
// Docs use the shapes of parseRequest()/parseFolder() in format.js, so the
// one serializer there writes the files (build.js for collections).

import { parseYaml } from '../format.js';
import { curl } from './curl.js';
import { postman } from './postman.js';

export const requestImporters = [curl];
export const collectionImporters = [postman];

/** Recognises the pasted text and converts it, or throws with a helpful message. */
export function importRequest(text) {
  const t = String(text || '').trim();
  const imp = requestImporters.find((i) => i.detect(t));
  if (!imp) throw new Error(`Unrecognised format. Supported: ${requestImporters.map((i) => i.label).join(', ')}.`);
  const { doc, warnings = [] } = imp.parse(t);
  return { format: imp.label, doc, warnings };
}

/** inputs: [{ name, text }]; JSON and YAML files are parsed once for all detectors. */
export function importCollection(inputs) {
  const all = inputs.map((i) => ({ ...i, json: parseData(i.text, i.name) }));
  const imp = collectionImporters.find((i) => all.some((x) => i.detect(x)));
  if (!imp) throw new Error(`Unrecognised file. Supported: ${collectionImporters.map((i) => i.label).join(', ')}.`);
  const result = imp.parse(all);
  return { format: imp.label, warnings: [], ...result };
}

function parseData(text, name = '') {
  try {
    return JSON.parse(text);
  } catch {
    // YAML only for .yaml/.yml or documents that start like one (e.g. "openapi: 3.0.0")
    if (!/\.ya?ml$/i.test(name) && !/^\s*(%YAML|---|[A-Za-z_][\w-]*:)/.test(text)) return undefined;
    const { doc, error } = parseYaml(text);
    return error || typeof doc !== 'object' ? undefined : doc;
  }
}

/** Request name from method and URL path, e.g. "GET users/{id}". */
export function nameFromUrl(method, url) {
  let path = String(url || '').replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/^\{\{[^}]+\}\}/, '');
  path = path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  return `${method || 'GET'} ${path || '/'}`.slice(0, 80);
}
