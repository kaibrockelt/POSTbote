// Bruno collections → a new collection. Two sources share one converter:
//
// - a collection folder (chosen as folder or zip): bruno.json, collection.bru,
//   folder.bru, <request>.bru, environments/*.bru, .env; input names are the
//   paths inside the folder
// - Bruno's JSON export (one file with items, environments, root)
//
// .bru files are parsed into the shape of the JSON export first. Assertions and
// vars:post-response become real POSTBote tests/scripts; bru.* scripts are kept
// as comments, like Postman scripts.
import { slug, parseEnv } from '../format.js';
import { BUILTINS } from '../vars.js';

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace'];
const isExport = (j) =>
  !!j && typeof j === 'object' && Array.isArray(j.items) && typeof j.name === 'string' && ('brunoConfig' in j || j.items.some((i) => /^(http-request|graphql-request|folder)$/.test(i?.type)));
const isBruFile = (name) => /\.bru$/i.test(name);
const isManifest = (name) => /(^|\/)bruno\.json$/i.test(name);

export const bruno = {
  id: 'bruno',
  label: 'Bruno collection (folder, zip or JSON export)',
  accept: ['.bru', '.json'],
  detect: (input) => isBruFile(input.name) || isManifest(input.name) || isExport(input.json),
  parse: parseBruno,
};

// variable names that usually hold secrets
const SECRET_NAME = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|credential|private|session|cookie)/i;

const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const kv = (key, value, disabled = false, extra = {}) => ({ key: str(key), value: str(value), file: '', disabled: !!disabled, ...extra });
const on = (list) => (list || []).filter((x) => x && x.name && x.enabled !== false);

// ------------------------------------------------------------ .bru files

/** Blocks of a .bru file: [{ name, open: '{' | '[', lines }]. */
export function parseBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!cur) {
      const m = /^([A-Za-z][\w:-]*)\s*([{[])\s*$/.exec(line);
      if (m) cur = { name: m[1], open: m[2], lines: [] };
      continue;
    }
    if (line === (cur.open === '{' ? '}' : ']')) {
      blocks.push(cur);
      cur = null;
    } else cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// text blocks (bodies, scripts, docs) are indented by two spaces
function textOf(b) {
  const lines = b.lines.map((l) => l.replace(/^ {2}/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.join('\n');
}

// key: value lines, "~" disables, ''' starts a multi-line value
function dictOf(b) {
  const out = [];
  const ls = b.lines;
  for (let i = 0; i < ls.length; i++) {
    const t = ls[i].trim();
    if (!t) continue;
    const disabled = t.startsWith('~');
    const s = disabled ? t.slice(1) : t;
    const c = s.indexOf(':');
    if (c < 0) continue;
    let name = s.slice(0, c).trim();
    let value = s.slice(c + 1).trim();
    if (/^".*"$/.test(name)) name = name.slice(1, -1);
    if (value === "'''") {
      const buf = [];
      for (i++; i < ls.length && ls[i].trim() !== "'''"; i++) buf.push(ls[i].replace(/^ {4}/, ''));
      value = buf.join('\n');
    }
    out.push({ name, value, enabled: !disabled });
  }
  return out;
}

// vars:secret [ a, ~b ]
function listOf(b) {
  return b.lines
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ name: s.replace(/^~/, ''), enabled: !s.startsWith('~') }));
}

/** One .bru file (request, folder.bru or collection.bru) in the shape of the JSON export. */
export function parseBru(text) {
  const blocks = parseBlocks(text);
  const by = new Map(blocks.map((b) => [b.name, b]));
  const d = (n) => (by.has(n) ? dictOf(by.get(n)) : []);
  const t = (n) => (by.has(n) ? textOf(by.get(n)) : '');
  const one = (n) => Object.fromEntries(d(n).map((x) => [x.name, x.value]));
  const meta = one('meta');
  const mb = blocks.find((b) => METHODS.includes(b.name));
  const m = mb ? one(mb.name) : {};

  const authMode = m.auth || one('auth').mode || 'inherit';
  const auth = { mode: authMode };
  if (authMode === 'bearer') auth.bearer = one('auth:bearer');
  if (authMode === 'basic') auth.basic = one('auth:basic');
  if (authMode === 'apikey') auth.apikey = one('auth:apikey');
  if (authMode === 'oauth2') auth.oauth2 = one('auth:oauth2');

  const bodies = { json: 'body:json', text: 'body:text', xml: 'body:xml', sparql: 'body:sparql', graphql: 'body:graphql', formUrlEncoded: 'body:form-urlencoded', multipartForm: 'body:multipart-form', file: 'body:file' };
  const mode = m.body || Object.keys(bodies).find((k) => by.has(bodies[k])) || 'none';
  const body = {
    mode,
    json: t('body:json'),
    text: t('body:text'),
    xml: t('body:xml'),
    sparql: t('body:sparql'),
    graphql: { query: t('body:graphql'), variables: t('body:graphql:vars') },
    formUrlEncoded: d('body:form-urlencoded'),
    multipartForm: d('body:multipart-form').map((f) => {
      const file = /^@file\((.*?)\)/.exec(f.value);
      const value = f.value.replace(/\s*@contentType\([^)]*\)\s*$/, '');
      return file ? { ...f, type: 'file', value: file[1].split('|') } : { ...f, type: 'text', value };
    }),
    file: d('body:file').map((f) => ({ filePath: /@file\((.*?)\)/.exec(f.value)?.[1] || '', contentType: /@contentType\((.*?)\)/.exec(f.value)?.[1] || '', selected: f.enabled })),
  };

  return {
    type: meta.type === 'graphql' ? 'graphql-request' : meta.type && meta.type !== 'http' ? meta.type : 'http-request',
    name: meta.name || '',
    seq: meta.seq,
    request: {
      method: (mb?.name || 'get').toUpperCase(),
      url: m.url || '',
      params: [...d('params:query').map((p) => ({ ...p, type: 'query' })), ...d('params:path').map((p) => ({ ...p, type: 'path' }))],
      headers: d('headers'),
      auth,
      body,
      vars: { req: d('vars:pre-request'), res: d('vars:post-response') },
      assertions: d('assert'),
      script: { req: t('script:pre-request'), res: t('script:post-response') },
      tests: t('tests'),
      docs: t('docs'),
    },
    docs: t('docs'),
  };
}

/** environments/<name>.bru → { name, variables: [{ name, value, enabled, secret }] } */
export function parseBruEnv(text, name) {
  const by = new Map(parseBlocks(text).map((b) => [b.name, b]));
  const vars = by.has('vars') ? dictOf(by.get('vars')) : [];
  for (const s of by.has('vars:secret') ? listOf(by.get('vars:secret')) : []) vars.push({ name: s.name, value: '', enabled: s.enabled, secret: true });
  return { name, variables: vars };
}

// folder of .bru files → JSON export shape
function fromFolder(inputs) {
  const files = inputs.filter((i) => isBruFile(i.name) || isManifest(i.name) || /(^|\/)\.env$/.test(i.name));
  const manifest = files.filter((i) => isManifest(i.name)).sort((a, b) => a.name.length - b.name.length)[0];
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  let root;
  if (manifest) root = dirOf(manifest.name);
  else {
    // without bruno.json: the common folder of all .bru files
    const dirs = files.filter((i) => isBruFile(i.name)).map((i) => dirOf(i.name).split('/'));
    root = (dirs[0] || []).filter((part, k) => dirs.every((x) => x[k] === part)).join('/');
  }
  const rel = (p) => (root ? (p.startsWith(root + '/') ? p.slice(root.length + 1) : null) : p);
  const config = manifest?.json || {};

  const col = { name: str(config.name) || root.split('/').pop() || 'Bruno collection', items: [], environments: [], root: null, dotenv: [] };
  const folders = new Map([['', col]]);
  const folderFor = (dir) => {
    if (folders.has(dir)) return folders.get(dir);
    const f = { type: 'folder', name: dir.split('/').pop(), items: [], root: null };
    folderFor(dirOf(dir)).items.push(f);
    folders.set(dir, f);
    return f;
  };

  for (const i of files) {
    const p = rel(i.name);
    if (p == null) continue;
    if (p === '.env') col.dotenv = parseEnv(i.text);
    else if (/^environments\/[^/]+\.bru$/i.test(p)) col.environments.push(parseBruEnv(i.text, p.slice(13, -4)));
    else if (p === 'collection.bru') col.root = parseBru(i.text);
    else if (/(^|\/)folder\.bru$/.test(p)) {
      const f = folderFor(dirOf(p));
      f.root = parseBru(i.text);
      if (f !== col && f.root.name) f.name = f.root.name;
      f.seq = f.root.seq;
    } else if (isBruFile(p)) {
      const it = parseBru(i.text);
      if (!it.name) it.name = p.split('/').pop().replace(/\.bru$/i, '');
      folderFor(dirOf(p)).items.push(it);
    }
  }
  return col;
}

// ------------------------------------------------------------ converter

export function parseBruno(inputs) {
  const exp = inputs.find((i) => isExport(i.json));
  const folderInputs = inputs.filter((i) => isBruFile(i.name) || isManifest(i.name));
  if (!exp && !folderInputs.some((i) => isBruFile(i.name))) throw new Error('No Bruno requests found. Choose the collection folder (or a zip of it), or Bruno’s JSON export.');
  const c = exp ? exp.json : fromFolder(inputs);
  const warnings = new Set();
  const ctx = { warnings, pathVars: new Map(), dynamic: new Set(), processEnv: new Set(), scripts: 0 };

  const rootReq = c.root?.request || {};
  const variables = on(rootReq.vars?.req).map((v) => kv(v.name, v.value));
  for (const v of variables) {
    if (v.value && SECRET_NAME.test(v.key)) warnings.add(`Collection variable “${v.key}” looks like a secret and is stored in postbote.yaml (committed). Move it to an environment.`);
  }

  const result = {
    name: str(c.name) || 'Bruno collection',
    docs: str(c.root?.docs ?? c.root?.request?.docs),
    collection: {
      variables,
      headers: headersOf(rootReq.headers),
      auth: convertAuth(rootReq.auth, 'the collection', ctx),
      scripts: scriptsOf(rootReq, ctx),
    },
    folders: [],
    requests: [],
    environments: [],
    warnings: [],
  };

  walk(c.items, 'requests', result, ctx);

  // :id path parameters become {{id}}; their values become collection variables
  for (const [key, value] of ctx.pathVars) {
    const have = result.collection.variables.find((v) => v.key === key);
    if (!have) result.collection.variables.push(kv(key, value));
    else if (value && have.value !== value) warnings.add(`Path parameter :${key} has different values; kept “${have.value}”`);
  }

  // {{process.env.X}} reads Bruno's .env (gitignored): becomes a private value {{X}}
  ctx.dotenv = new Map((c.dotenv || []).map((e) => [e.key, e.value]));
  for (const e of c.environments || []) {
    const values = on(e.variables).map((v) => ({ key: str(v.name), value: str(v.value), secret: !!v.secret || SECRET_NAME.test(v.name) }));
    result.environments.push({ name: str(e.name) || 'imported', values });
  }
  if ((c.environments || []).some((e) => (e.variables || []).some((v) => v.secret))) warnings.add('Bruno keeps secret environment values outside the collection; they are declared empty in the private files – fill them in');

  const unsupported = [...ctx.dynamic].filter((n) => !BUILTINS.includes(n));
  if (unsupported.length) warnings.add(`Dynamic variables without an equivalent: ${unsupported.map((n) => `{{${n}}}`).join(', ')}`);
  if (ctx.scripts) warnings.add(`${ctx.scripts} Bruno script${ctx.scripts > 1 ? 's were' : ' was'} imported as comments (bru.* is not supported yet); assertions and post-response variables were converted`);
  result.warnings = [...warnings];
  return fixVars(result, ctx);
}

const seqOf = (it) => {
  const n = Number(it.seq ?? it.root?.seq ?? it.root?.meta?.seq);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
};

function walk(items, dir, result, ctx) {
  const used = new Set();
  const sorted = [...(items || [])].filter((x) => x && typeof x === 'object').sort((a, b) => seqOf(a) - seqOf(b) || str(a.name).localeCompare(str(b.name)));
  for (const it of sorted) {
    if (it.type === 'folder') {
      const base = slug(it.name) || 'folder';
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
      used.add(name);
      const path = `${dir}/${name}`;
      const req = it.root?.request || {};
      result.folders.push({
        path,
        doc: {
          name: str(it.name),
          variables: on(req.vars?.req).map((v) => kv(v.name, v.value)),
          headers: headersOf(req.headers),
          auth: convertAuth(req.auth, `folder “${it.name}”`, ctx),
          scripts: scriptsOf(req, ctx),
        },
        docs: str(it.root?.docs ?? req.docs),
      });
      walk(it.items, path, result, ctx);
    } else if (it.type === 'http-request' || it.type === 'graphql-request') {
      result.requests.push({ dir, doc: convertRequest(it, ctx) });
    } else {
      ctx.warnings.add(`“${it.name}”: ${it.type} requests are not supported, skipped`);
    }
  }
}

const headersOf = (h) => (h || []).filter((x) => x && x.name).map((x) => kv(x.name, x.value, x.enabled === false));

function convertRequest(it, ctx) {
  const r = it.request || {};
  const where = `request “${it.name}”`;
  const params = r.params || [];
  const raw = str(r.url);
  const q = raw.indexOf('?');
  let url = q >= 0 ? raw.slice(0, q) : raw;
  let query = params.filter((p) => p && p.name && p.type !== 'path').map((p) => kv(p.name, p.value, p.enabled === false));
  if (!query.length && q >= 0) {
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
  for (const p of params) if (p?.type === 'path' && p.name && !ctx.pathVars.get(p.name)) ctx.pathVars.set(str(p.name), str(p.value));
  url = url.replace(/(\/):([A-Za-z_][\w-]*)(?=\/|$)/g, (_, slash, name) => {
    if (!ctx.pathVars.has(name)) ctx.pathVars.set(name, '');
    return `${slash}{{${name}}}`;
  });

  const headers = headersOf(r.headers);
  const doc = {
    name: str(it.name) || 'request',
    method: str(r.method || 'GET').toUpperCase(),
    url,
    params: query,
    headers,
    auth: convertAuth(r.auth, where, ctx),
    body: convertBody(r.body, headers, where, ctx),
    scripts: scriptsOf(r, ctx, true),
    docs: str(r.docs ?? it.docs),
  };
  for (const m of JSON.stringify(doc).matchAll(/\{\{\s*(\$[A-Za-z]+)\s*\}\}/g)) ctx.dynamic.add(m[1]);
  return doc;
}

function convertBody(b, headers, where, ctx) {
  const none = { type: 'none', content: '', fields: [] };
  if (!b || !b.mode || b.mode === 'none') return none;
  switch (b.mode) {
    case 'json':
      return b.json ? { type: 'json', content: str(b.json), fields: [] } : none;
    case 'xml':
      return b.xml ? { type: 'xml', content: str(b.xml), fields: [] } : none;
    case 'text':
      return b.text ? { type: 'text', content: str(b.text), fields: [] } : none;
    case 'sparql':
      ctx.warnings.add(`${where}: SPARQL body imported as text`);
      return { type: 'text', content: str(b.sparql), fields: [] };
    case 'formUrlEncoded':
      return { type: 'form', content: '', fields: (b.formUrlEncoded || []).filter((f) => f && f.name).map((f) => kv(f.name, f.value, f.enabled === false)) };
    case 'multipartForm': {
      // the multipart boundary is generated when sending
      const i = headers.findIndex((h) => h.key.toLowerCase() === 'content-type' && /multipart\/form-data/i.test(h.value));
      if (i >= 0) headers.splice(i, 1);
      const fields = (b.multipartForm || [])
        .filter((f) => f && f.name)
        .map((f) => {
          if (f.type !== 'file') return kv(f.name, f.value, f.enabled === false);
          const paths = (Array.isArray(f.value) ? f.value : [f.value]).filter(Boolean);
          if (paths.length > 1) ctx.warnings.add(`${where}: form field “${f.name}” has several files; only the first was kept`);
          ctx.warnings.add(`${where}: form file “${f.name}” – copy the file into the collection and check its path`);
          return kv(f.name, '', f.enabled === false, { file: str(paths[0]) });
        });
      return { type: 'multipart', content: '', fields };
    }
    case 'graphql': {
      let variables = str(b.graphql?.variables);
      try {
        if (variables.trim()) variables = JSON.stringify(JSON.parse(variables), null, 2);
      } catch {
        ctx.warnings.add(`${where}: GraphQL variables are not valid JSON yet`);
      }
      return { type: 'graphql', content: str(b.graphql?.query), fields: [], variables };
    }
    case 'file': {
      const list = b.file || [];
      const f = list.find((x) => x?.selected !== false) || list[0];
      ctx.warnings.add(`${where}: copy the body file${f?.filePath ? ` “${f.filePath}”` : ''} into the collection and check its path`);
      return { type: 'file', content: '', fields: [], file: str(f?.filePath) };
    }
    default:
      ctx.warnings.add(`${where}: body mode “${b.mode}” is not supported`);
      return none;
  }
}

function convertAuth(a, where, ctx) {
  switch (a?.mode) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: str(a.bearer?.token) };
    case 'basic':
      return { type: 'basic', username: str(a.basic?.username), password: str(a.basic?.password) };
    case 'apikey':
      return { type: 'apikey', key: str(a.apikey?.key), value: str(a.apikey?.value), in: /query/i.test(a.apikey?.placement) ? 'query' : 'header' };
    case 'oauth2': {
      ctx.warnings.add(`${where}: OAuth 2.0 flows are not supported yet; imported as bearer token {{token}}`);
      return { type: 'bearer', token: '{{token}}' };
    }
    case undefined:
    case null:
    case '':
    case 'inherit':
      return { type: 'inherit' };
    default:
      ctx.warnings.add(`${where}: auth type “${a.mode}” is not supported; it inherits instead`);
      return { type: 'inherit' };
  }
}

// ------------------------------------------------------------ scripts

const js = (v) => JSON.stringify(v);

function commented(label, code, ctx) {
  const c = str(code).trim();
  if (!c) return '';
  ctx.scripts++;
  return `// Bruno ${label} (bru.* is not supported yet):\n${c
    .split('\n')
    .map((l) => `// ${l}`.trimEnd())
    .join('\n')}\n`;
}

// Bruno's res: body is parsed JSON, plus getters
const RES_SHIM = `// Bruno-style response for the converted assertions and variables
const bruRes = { status: res.status, statusText: res.statusText, headers: res.headers, responseTime: res.timeMs,
  body: (() => { try { return res.json(); } catch (e) { return res.body; } })() };
Object.assign(bruRes, { getStatus: () => bruRes.status, getBody: () => bruRes.body, getHeader: (n) => res.header(n), getHeaders: () => res.headers, getResponseTime: () => res.timeMs });
const isEmpty = (v) => v == null || (typeof v === 'object' ? Object.keys(v).length === 0 : String(v) === '');`;

function scriptsOf(r, ctx, isRequest = false) {
  const pre = [];
  const post = [];
  // request vars: set before the placeholders are resolved (collection and
  // folder vars are plain variables instead)
  if (isRequest) for (const v of on(r.vars?.req)) pre.push(`vars.set(${js(v.name)}, vars.interpolate(${js(str(v.value))}));`);
  const resVars = on(r.vars?.res);
  const asserts = on(r.assertions);
  if (resVars.length || asserts.length) post.push(RES_SHIM);
  for (const v of resVars) post.push(`vars.set(${js(v.name)}, ((res) => (${v.value}))(bruRes));`);
  for (const a of asserts) post.push(assertion(a));
  const preScript = commented('pre-request script', r.script?.req, ctx);
  const postScript = commented('post-response script', r.script?.res, ctx);
  const tests = commented('tests', r.tests, ctx);
  return {
    pre: [pre.join('\n'), preScript].filter(Boolean).join('\n'),
    post: [post.join('\n'), postScript, tests].filter(Boolean).join('\n'),
  };
}

// "eq 200", "contains \"x\"", "in 1, 2"
function literal(s) {
  const t = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) || /^(true|false|null|undefined)$/.test(t)) return t;
  if (/^"(?:[^"\\]|\\.)*"$/.test(t) || /^'[^']*'$/.test(t)) return t;
  return js(t);
}
const list = (s) => s.split(',').map(literal).join(', ');

/** One Bruno assertion as a POSTBote test. */
export function assertion(a) {
  const lhs = str(a.name).trim();
  const m = /^(\w+)\s*([\s\S]*)$/.exec(str(a.value).trim()) || [];
  const op = m[1] || 'eq';
  const arg = m[2] ?? '';
  const L = `(${lhs})`;
  const checks = {
    eq: `expect(${L}).toEqual(${literal(arg)})`,
    neq: `expect(${L}).not.toEqual(${literal(arg)})`,
    gt: `expect(${L}).toBeGreaterThan(${literal(arg)})`,
    gte: `expect(${L}).toBeGreaterThanOrEqual(${literal(arg)})`,
    lt: `expect(${L}).toBeLessThan(${literal(arg)})`,
    lte: `expect(${L}).toBeLessThanOrEqual(${literal(arg)})`,
    in: `expect([${list(arg)}]).toContain(${L})`,
    notIn: `expect([${list(arg)}]).not.toContain(${L})`,
    contains: `expect(${L}).toContain(${literal(arg)})`,
    notContains: `expect(${L}).not.toContain(${literal(arg)})`,
    length: `expect(${L}).toHaveLength(${literal(arg)})`,
    matches: `expect(String(${L})).toMatch(new RegExp(${js(arg.trim())}))`,
    notMatches: `expect(String(${L})).not.toMatch(new RegExp(${js(arg.trim())}))`,
    startsWith: `expect(String(${L}).startsWith(${literal(arg)})).toBe(true)`,
    endsWith: `expect(String(${L}).endsWith(${literal(arg)})).toBe(true)`,
    between: `{ const v = ${L}; const [lo, hi] = [${list(arg)}]; expect(v).toBeGreaterThanOrEqual(lo); expect(v).toBeLessThanOrEqual(hi); }`,
    isEmpty: `expect(isEmpty(${L})).toBe(true)`,
    isNotEmpty: `expect(isEmpty(${L})).toBe(false)`,
    isNull: `expect(${L}).toBeNull()`,
    isUndefined: `expect(${L}).toBeUndefined()`,
    isDefined: `expect(${L}).toBeDefined()`,
    isTruthy: `expect(${L}).toBeTruthy()`,
    isFalsy: `expect(${L}).toBeFalsy()`,
    isJson: `expect(${L}).toBeType('object')`,
    isNumber: `expect(${L}).toBeType('number')`,
    isString: `expect(${L}).toBeType('string')`,
    isBoolean: `expect(${L}).toBeType('boolean')`,
    isArray: `expect(${L}).toBeType('array')`,
  };
  const name = js(`${lhs} ${str(a.value).trim()}`.trim());
  if (!checks[op]) return `// Bruno assertion not converted: ${lhs}: ${str(a.value).trim()}`;
  return `test(${name}, () => { const res = bruRes; ${checks[op]}; });`;
}

// {{process.env.X}} reads Bruno's .env (gitignored): becomes {{X}} everywhere,
// with the value in the private part of every environment
function fixVars(result, ctx) {
  const json = JSON.stringify(result).replace(/\{\{\s*process\.env\.([A-Za-z_][\w]*)\s*\}\}/g, (_, n) => {
    ctx.processEnv.add(n);
    return `{{${n}}}`;
  });
  if (!ctx.processEnv.size) return result;
  const r = JSON.parse(json);
  if (!r.environments.length) r.environments.push({ name: 'default', values: [] });
  for (const env of r.environments) for (const key of ctx.processEnv) if (!env.values.some((v) => v.key === key)) env.values.push({ key, value: ctx.dotenv?.get(key) || '', secret: true });
  r.warnings.push(`{{process.env.…}} became {{${[...ctx.processEnv].join('}}, {{')}}}, stored as private values${ctx.dotenv?.size ? ' (from .env)' : ' – fill them in'}`);
  return r;
}
