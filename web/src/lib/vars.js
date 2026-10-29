// Static view of the variables a request can see, used for highlighting,
// autocomplete and code snippets. Mirrors the runtime lookup order:
// runtime vars > data row > environment > request > folders > collection.
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
  request: 'Request variable (default; a workflow fills it from its input)',
  input: 'Workflow input (sample from the request variable “input”)',
  missing: 'Unresolved',
};

const INPUT_RE = /\{\{\s*input(?:\.([^{}\s]+))?\s*\}\}/g;
const isEnv = (v) => v && (v.source === 'env' || v.source === 'envpub');

/** Keys of {{input}} / {{input.x}} placeholders used in a request doc ('_' = the whole input). */
export function inputKeys(doc) {
  const keys = new Set();
  for (const m of JSON.stringify(doc ?? {}).matchAll(INPUT_RE)) keys.add(m[1] || '_');
  return [...keys];
}

/** Declared request variables whose name the environment also sets (the environment wins). */
export function shadowedByEnv(scope, doc) {
  return (doc?.variables || []).filter((r) => r.key && r.key !== 'input' && isEnv(scope.get(r.key))).map((r) => r.key);
}

/**
 * Adds the request's variables to a scope: above folders and collection,
 * below the environment. The variable `input` is the sample for
 * {{input}} / {{input.x}} when the request runs on its own.
 */
export function withRequestVars(scope, doc) {
  const vars = (doc?.variables || []).filter((r) => r.key);
  const keys = inputKeys(doc);
  if (!vars.length && !keys.length) return scope;
  const m = new Map(scope);
  for (const r of vars) {
    if (r.key === 'input' || isEnv(m.get(r.key))) continue;
    m.set(r.key, { name: r.key, value: r.value, source: 'request', label: 'Request variable' });
  }
  const raw = vars.find((r) => r.key === 'input')?.value ?? '';
  let sample = raw;
  try {
    sample = JSON.parse(raw);
  } catch {}
  for (const k of keys) {
    const name = k === '_' ? 'input' : `input.${k}`;
    let value = k === '_' ? raw : k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), sample);
    if (value == null) value = '';
    else if (typeof value === 'object') value = JSON.stringify(value);
    m.set(name, { name, value: String(value), source: 'input', label: 'Request variable “input”' });
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
// like the runner: configured values may reference other variables (a few levels deep)
export function interpolate(text, scope, depth = 0) {
  return String(text ?? '').replace(VAR_RE, (m, n) => {
    const v = scope.get(n.trim());
    // workflow inputs are data: inserted literally, never resolved again
    if (v?.source === 'input') return v.value === '' ? m : v.value;
    if (!v || !['collection', 'folder', 'request', 'envpub', 'env'].includes(v.source)) return m;
    return depth < 4 && v.value.includes('{{') ? interpolate(v.value, scope, depth + 1) : v.value;
  });
}

export { ancestors };
