// Postman collection v2.0 / v2.1 (JSON) plus Postman environment and globals
// files → a new collection. Scripts (pm.*) are kept as comments for now.
import { slug } from '../format.js';
import { BUILTINS } from '../vars.js';

const isCollection = (j) => !!j && typeof j === 'object' && !!j.info && Array.isArray(j.item);
const isV1 = (j) => !!j && typeof j === 'object' && Array.isArray(j.requests) && Array.isArray(j.order ?? j.requests);
const isEnvironment = (j) => !!j && typeof j === 'object' && Array.isArray(j.values) && !j.item && ('_postman_variable_scope' in j || 'name' in j);

export const postman = {
  id: 'postman',
  label: 'Postman collection (v2.0/v2.1) + environments',
  accept: ['.json', '.postman_collection.json', '.postman_environment.json'],
  detect: (input) => isCollection(input.json) || isV1(input.json),
  parse: parsePostman,
};

// variable names that usually hold secrets
const SECRET_NAME = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|credential|private|session|cookie)/i;

const text = (d) => (typeof d === 'string' ? d : d && typeof d === 'object' ? String(d.content ?? '') : '');
const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const kv = (key, value, disabled = false, extra = {}) => ({ key: str(key), value: str(value), file: '', disabled: !!disabled, ...extra });

export function parsePostman(inputs) {
  const col = inputs.find((i) => isCollection(i.json));
  if (!col) {
    if (inputs.some((i) => isV1(i.json))) throw new Error('Postman collection v1 is not supported. In Postman, export the collection as v2.1.');
    throw new Error('No Postman collection among the selected files (environments alone cannot be imported).');
  }
  const c = col.json;
  const warnings = new Set();
  const ctx = { warnings, pathVars: new Map(), dynamic: new Set(), examples: 0, scripts: 0 };

  for (const i of inputs) {
    if (i === col) continue;
    if (isCollection(i.json)) warnings.add(`${i.name}: only one collection per import, ignored`);
    else if (!isEnvironment(i.json)) warnings.add(`${i.name}: not a Postman environment, ignored`);
  }

  const variables = (c.variable || []).filter((v) => v && v.key && !v.disabled).map((v) => kv(v.key, v.value));
  for (const v of variables) {
    if (v.value && SECRET_NAME.test(v.key)) warnings.add(`Collection variable “${v.key}” looks like a secret and is stored in postbote.yaml (committed). Move it to an environment.`);
  }

  const result = {
    name: str(c.info.name) || col.name.replace(/(\.postman_collection)?\.json$/i, ''),
    docs: text(c.info.description),
    collection: {
      variables,
      headers: [],
      auth: c.auth ? convertAuth(c.auth, 'the collection', ctx) : undefined,
      scripts: convertEvents(c.event, ctx),
    },
    folders: [],
    requests: [],
    environments: [],
    warnings: [],
  };

  walk(c.item, 'requests', result, ctx);

  // :id path variables become {{id}}; their default values become collection variables
  for (const [key, value] of ctx.pathVars) {
    const have = result.collection.variables.find((v) => v.key === key);
    if (!have) result.collection.variables.push(kv(key, value));
    else if (value && have.value !== value) warnings.add(`Path variable :${key} has different values; kept “${have.value}”`);
  }

  for (const i of inputs) {
    if (!isEnvironment(i.json)) continue;
    const global = i.json._postman_variable_scope === 'globals';
    const name = global ? 'globals' : str(i.json.name) || i.name.replace(/(\.postman_environment)?\.json$/i, '');
    const values = i.json.values
      .filter((v) => v && v.key && v.enabled !== false)
      .map((v) => ({ key: str(v.key), value: str(v.value), secret: v.type === 'secret' || SECRET_NAME.test(v.key) }));
    result.environments.push({ name, values });
    if (global) warnings.add('Postman globals were imported as the environment “globals”');
  }

  const unsupported = [...ctx.dynamic].filter((n) => !BUILTINS.includes(n));
  if (unsupported.length) warnings.add(`Postman dynamic variables without an equivalent: ${unsupported.map((n) => `{{${n}}}`).join(', ')}`);
  if (ctx.scripts) warnings.add(`${ctx.scripts} Postman script${ctx.scripts > 1 ? 's were' : ' was'} imported as comments (pm.* is not supported yet)`);
  if (ctx.examples) warnings.add(`${ctx.examples} saved example response${ctx.examples > 1 ? 's were' : ' was'} not imported`);
  result.warnings = [...warnings];
  return result;
}

function walk(items, dir, result, ctx) {
  const used = new Set();
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    if (Array.isArray(it.item)) {
      let base = slug(it.name) || 'folder';
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
      used.add(name);
      const path = `${dir}/${name}`;
      result.folders.push({
        path,
        doc: {
          name: str(it.name),
          variables: (it.variable || []).filter((v) => v && v.key && !v.disabled).map((v) => kv(v.key, v.value)),
          auth: it.auth ? convertAuth(it.auth, `folder “${it.name}”`, ctx) : undefined,
          scripts: convertEvents(it.event, ctx),
        },
        docs: text(it.description),
      });
      walk(it.item, path, result, ctx);
    } else if (it.request) {
      result.requests.push({ dir, doc: convertRequest(it, ctx) });
      if (Array.isArray(it.response)) ctx.examples += it.response.length;
    }
  }
}

function convertRequest(it, ctx) {
  const r = typeof it.request === 'string' ? { url: it.request, method: 'GET' } : it.request;
  const where = `request “${it.name}”`;
  const { url, params } = convertUrl(r.url, ctx);
  const headers = convertHeaders(r.header);
  const body = convertBody(r.body, headers, where, ctx);
  const doc = {
    name: str(it.name) || 'request',
    method: str(r.method || 'GET').toUpperCase(),
    url,
    params,
    headers,
    auth: r.auth ? convertAuth(r.auth, where, ctx) : { type: 'inherit' },
    body,
    scripts: convertEvents(it.event, ctx),
    docs: text(r.description ?? it.description),
  };
  for (const m of JSON.stringify(doc).matchAll(/\{\{\s*(\$[A-Za-z]+)\s*\}\}/g)) ctx.dynamic.add(m[1]);
  return doc;
}

function convertUrl(u, ctx) {
  let raw = '';
  let query = null;
  if (typeof u === 'string') raw = u;
  else if (u && typeof u === 'object') {
    if (u.raw) raw = u.raw;
    else {
      const host = Array.isArray(u.host) ? u.host.join('.') : str(u.host);
      const path = Array.isArray(u.path) ? u.path.map((p) => (typeof p === 'object' ? str(p.value) : p)).join('/') : str(u.path);
      raw = `${u.protocol ? `${u.protocol}://` : ''}${host}${u.port ? `:${u.port}` : ''}${path ? `/${path}` : ''}`;
    }
    if (Array.isArray(u.query)) query = u.query.filter(Boolean).map((q) => kv(q.key, q.value, q.disabled));
    for (const v of u.variable || []) if (v?.key) ctx.pathVars.has(v.key) || ctx.pathVars.set(str(v.key), str(v.value));
  }
  // the query lives in params; Postman's raw URL repeats it
  const q = raw.indexOf('?');
  let url = q >= 0 ? raw.slice(0, q) : raw;
  if (!query && q >= 0) {
    query = raw
      .slice(q + 1)
      .split('#')[0]
      .split('&')
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return i < 0 ? kv(p, '') : kv(p.slice(0, i), p.slice(i + 1));
      });
  }
  // /users/:id → /users/{{id}}
  url = url.replace(/(\/):([A-Za-z_][\w-]*)(?=\/|$)/g, (_, slash, name) => {
    if (!ctx.pathVars.has(name)) ctx.pathVars.set(name, '');
    return `${slash}{{${name}}}`;
  });
  return { url, params: query || [] };
}

function convertHeaders(h) {
  if (typeof h === 'string') {
    return h
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':');
        return kv(i < 0 ? l : l.slice(0, i).trim(), i < 0 ? '' : l.slice(i + 1).trim());
      });
  }
  return (h || []).filter((x) => x && x.key).map((x) => kv(x.key, x.value, x.disabled));
}

function convertBody(b, headers, where, ctx) {
  const none = { type: 'none', content: '', fields: [] };
  if (!b || b.disabled || !b.mode) return none;
  const ct = (headers.find((h) => h.key.toLowerCase() === 'content-type')?.value || '').toLowerCase();
  switch (b.mode) {
    case 'raw': {
      const lang = b.options?.raw?.language || '';
      const content = str(b.raw);
      if (!content) return none;
      if (lang === 'json' || (!lang && ct.includes('json'))) return { type: 'json', content, fields: [] };
      if (lang === 'xml' || (!lang && ct.includes('xml'))) return { type: 'xml', content, fields: [] };
      return { type: 'text', content, fields: [] };
    }
    case 'urlencoded':
      return { type: 'form', content: '', fields: (b.urlencoded || []).filter((f) => f && f.key).map((f) => kv(f.key, f.value, f.disabled)) };
    case 'formdata': {
      // the multipart boundary is generated when sending
      const i = headers.findIndex((h) => h.key.toLowerCase() === 'content-type' && /multipart\/form-data/i.test(h.value));
      if (i >= 0) headers.splice(i, 1);
      const fields = (b.formdata || [])
        .filter((f) => f && f.key)
        .map((f) => {
          if (f.type !== 'file') return kv(f.key, f.value, f.disabled);
          const src = Array.isArray(f.src) ? f.src[0] : f.src;
          ctx.warnings.add(`${where}: form file “${f.key}” – put the file into the collection and set its path`);
          return kv(f.key, '', f.disabled, { file: str(src).split(/[\\/]/).pop() });
        });
      return { type: 'multipart', content: '', fields };
    }
    case 'graphql': {
      let variables = b.graphql?.variables;
      try {
        variables = typeof variables === 'string' && variables.trim() ? JSON.parse(variables) : variables || undefined;
      } catch {
        ctx.warnings.add(`${where}: GraphQL variables are not valid JSON and were dropped`);
        variables = undefined;
      }
      ctx.warnings.add(`${where}: GraphQL is imported as a JSON body ({ query, variables })`);
      return { type: 'json', content: JSON.stringify({ query: str(b.graphql?.query), variables }, null, 2), fields: [] };
    }
    case 'file':
      ctx.warnings.add(`${where}: binary file bodies are not supported`);
      return none;
    default:
      ctx.warnings.add(`${where}: body mode “${b.mode}” is not supported`);
      return none;
  }
}

// v2.1: { type, bearer: [{ key, value }] }; v2.0: { type, bearer: { token } }
function authParam(a, key) {
  const p = a[a.type];
  if (Array.isArray(p)) return str(p.find((x) => x && x.key === key)?.value);
  return p && typeof p === 'object' ? str(p[key]) : '';
}

function convertAuth(a, where, ctx) {
  switch (a?.type) {
    case 'noauth':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: authParam(a, 'token') };
    case 'basic':
      return { type: 'basic', username: authParam(a, 'username'), password: authParam(a, 'password') };
    case 'apikey':
      return { type: 'apikey', key: authParam(a, 'key'), value: authParam(a, 'value'), in: authParam(a, 'in') === 'query' ? 'query' : 'header' };
    case 'oauth2': {
      const token = authParam(a, 'accessToken');
      ctx.warnings.add(`${where}: OAuth 2.0 flows are not supported yet; imported as bearer token${token ? '' : ' (empty)'}`);
      return { type: 'bearer', token };
    }
    case undefined:
    case null:
    case 'inherit':
      return { type: 'inherit' };
    default:
      ctx.warnings.add(`${where}: auth type “${a.type}” is not supported; it inherits instead`);
      return { type: 'inherit' };
  }
}

function convertEvents(events, ctx) {
  const out = { pre: '', post: '' };
  for (const e of events || []) {
    const exec = e?.script?.exec;
    const code = (Array.isArray(exec) ? exec.join('\n') : str(exec)).trim();
    if (!code || e.disabled) continue;
    const slot = e.listen === 'prerequest' ? 'pre' : e.listen === 'test' ? 'post' : null;
    if (!slot) continue;
    ctx.scripts++;
    out[slot] = `// Postman ${e.listen} script (pm.* is not supported yet):\n${code
      .split('\n')
      .map((l) => `// ${l}`.trimEnd())
      .join('\n')}\n`;
  }
  return out;
}
