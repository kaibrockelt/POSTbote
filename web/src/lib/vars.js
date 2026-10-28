// Static view of the variables a request can see, used for highlighting,
// autocomplete and code snippets. Mirrors the runtime lookup order:
// runtime vars > data row > environment > folders > collection.
import {
  MANIFEST,
  FOLDER_FILE,
  RUNNER_EXT,
  parseCollection,
  parseFolder,
  parseEnv,
  parseWorkflow,
  envPublicPath,
  envPrivatePath,
} from './format.js';

export const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export const BUILTINS = ['$uuid', '$guid', '$timestamp', '$timestampMs', '$isoTimestamp', '$randomInt'];

/** source: 'collection' | 'folder' | 'envpub' | 'env' | 'runtime' | 'builtin' */
export const SOURCE_LABEL = {
  collection: 'Collection variable',
  folder: 'Folder variable',
  envpub: 'Environment variable (shared)',
  env: 'Environment variable (private)',
  runtime: 'Set at runtime (script or runner data)',
  builtin: 'Built-in dynamic value',
  input: 'Workflow input (sample value from the Inputs tab)',
  missing: 'Unresolved',
};

const INPUT_RE = /\{\{\s*input(?:\.([^{}\s]+))?\s*\}\}/g;

/** Keys of {{input}} / {{input.x}} placeholders used in a request doc ('_' = the whole input). */
export function inputKeys(doc) {
  const keys = new Set();
  for (const m of JSON.stringify(doc ?? {}).matchAll(INPUT_RE)) keys.add(m[1] || '_');
  return [...keys];
}

/** Adds the request's sample inputs (and used input placeholders) to a scope. */
export function withInputs(scope, doc) {
  const inputs = doc?.inputs || {};
  const keys = new Set([...inputKeys(doc), ...Object.keys(inputs)]);
  if (!keys.size) return scope;
  const m = new Map(scope);
  for (const k of keys) {
    const name = k === '_' ? 'input' : `input.${k}`;
    m.set(name, { name, value: inputs[k] ?? '', source: 'input', label: 'Inputs tab' });
  }
  return m;
}

function ancestors(path) {
  const out = [];
  let d = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  while (d) {
    out.unshift(d);
    d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
  }
  return out;
}

function dataColumns(text, path) {
  if (!text) return [];
  if (/\.(csv|tsv)$/.test(path)) {
    const first = text.split('\n')[0] || '';
    return first.split(path.endsWith('.tsv') ? '\t' : ',').map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) && rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [];
  } catch {
    return [];
  }
}

const SET_RE = /vars\.set\(\s*['"`]([^'"`]+)['"`]/g;

/**
 * Map name -> { name, value, source, label, masked } for the request at
 * `reqPath` (folder chain) with the environment `env` (name) active.
 */
export function variableScope(files, env, reqPath = '') {
  const m = new Map();
  const put = (name, value, source, label, masked = false) => m.set(name, { name, value, source, label, masked });

  for (const v of parseCollection(files[MANIFEST] || '').doc?.variables || []) if (v.key) put(v.key, v.value, 'collection', 'Collection');
  for (const dir of ancestors(reqPath)) {
    const text = files[`${dir}/${FOLDER_FILE}`];
    if (!text) continue;
    for (const v of parseFolder(text).doc?.variables || []) if (v.key) put(v.key, v.value, 'folder', `Folder ${dir.replace(/^requests\/?/, '') || '/'}`);
  }
  if (env) {
    const pub = files[envPublicPath(env)];
    const priv = files[envPrivatePath(env)];
    if (pub != null) for (const v of parseEnv(pub)) put(v.key, v.value, 'envpub', `${env} (shared)`);
    // private values override; an empty private value does not hide a shared one
    if (priv != null) for (const v of parseEnv(priv)) if (v.value !== '' || !m.has(v.key) || m.get(v.key).source !== 'envpub') put(v.key, v.value, 'env', `${env} (private)`, true);
  }

  // names that only exist at runtime: vars.set(...) in scripts, runner data columns
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith(RUNNER_EXT)) {
      const w = parseWorkflow(text).doc;
      if (w?.data) for (const c of dataColumns(files[w.data], w.data)) if (!m.has(c)) put(c, '', 'runtime', `Data column of ${w.data}`);
    }
    if (path.endsWith('.yaml') && text.includes('vars.set')) {
      for (const [, name] of text.matchAll(SET_RE)) if (!m.has(name)) put(name, '', 'runtime', 'Set by a script (vars.set)');
    }
  }
  for (const b of BUILTINS) put(b, '', 'builtin', 'Built-in, generated per request');
  return m;
}

/** Splits text into plain and variable segments for highlighting. */
export function tokenize(text, scope) {
  const out = [];
  let last = 0;
  for (const match of String(text ?? '').matchAll(VAR_RE)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index) });
    const v = scope.get(match[1].trim());
    out.push({ text: match[0], source: v ? v.source : 'missing', name: match[1].trim() });
    last = match.index + match[0].length;
  }
  if (last < String(text ?? '').length) out.push({ text: text.slice(last) });
  return out;
}

/** Replaces known values; runtime/built-in/unknown names stay as {{name}}. */
export function interpolate(text, scope) {
  return String(text ?? '').replace(VAR_RE, (m, n) => {
    const v = scope.get(n.trim());
    if (v?.source === 'input') return v.value === '' ? m : v.value;
    return v && ['collection', 'folder', 'envpub', 'env'].includes(v.source) ? v.value : m;
  });
}

export { ancestors };
