// Parsing and serialisation of the collection files. Output is kept minimal
// (empty fields are omitted) so diffs in git stay small and readable.
import YAML from 'yaml';

export const MANIFEST = 'postbote.yaml';
export const FOLDER_FILE = '_folder.yaml';
export const REQ_EXT = '.req.yaml';
export const FLOW_EXT = '.flow.yaml';
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function parseYaml(text) {
  try {
    const data = YAML.parse(text || '') ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) return { doc: null, error: 'file must contain a YAML mapping' };
    return { doc: data, error: null };
  } catch (e) {
    return { doc: null, error: e.message };
  }
}

const dump = (o) => YAML.stringify(o, { lineWidth: 0 });

const str = (v) => (v == null ? '' : String(v));
const isEmpty = (v) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

function prune(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!isEmpty(v)) out[k] = v;
  return out;
}

export function normKv(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({
    key: str(r?.key),
    value: str(r?.value),
    file: str(r?.file),
    disabled: !!r?.disabled,
  }));
}

function cleanKv(list) {
  return normKv(list)
    .filter((r) => r.key !== '' || r.value !== '' || r.file !== '')
    .map((r) => {
      const o = { key: r.key, value: r.value };
      if (r.file) o.file = r.file;
      if (r.disabled) o.disabled = true;
      return o;
    });
}

// variables are stored as a YAML mapping; edited as a key/value list
export function mapToKv(m) {
  return Object.entries(m && typeof m === 'object' ? m : {}).map(([key, value]) => ({ key, value: str(value), file: '', disabled: false }));
}

function kvToMap(list) {
  const m = {};
  for (const r of normKv(list)) if (r.key && !r.disabled) m[r.key] = r.value;
  return m;
}

export function normAuth(a) {
  return {
    type: str(a?.type) || 'inherit',
    token: str(a?.token),
    username: str(a?.username),
    password: str(a?.password),
    key: str(a?.key),
    value: str(a?.value),
    in: str(a?.in) || 'header',
  };
}

function cleanAuth(a, allowInherit = true) {
  const n = normAuth(a);
  if (n.type === 'inherit' && allowInherit) return undefined;
  switch (n.type) {
    case 'bearer':
      return { type: 'bearer', token: n.token };
    case 'basic':
      return { type: 'basic', username: n.username, password: n.password };
    case 'apikey':
      return prune({ type: 'apikey', key: n.key, value: n.value, in: n.in === 'query' ? 'query' : undefined });
    case 'none':
      return { type: 'none' };
    default:
      return undefined;
  }
}

const normScripts = (s) => ({ pre: str(s?.pre), post: str(s?.post) });
const cleanScripts = (s) => prune({ pre: str(s?.pre), post: str(s?.post) });

// ------------------------------------------------------------ request

export function parseRequest(text) {
  const { doc, error } = parseYaml(text);
  if (error) return { doc: null, error };
  return {
    error: null,
    doc: {
      name: str(doc.name),
      method: str(doc.method).toUpperCase() || 'GET',
      url: str(doc.url),
      params: normKv(doc.params),
      headers: normKv(doc.headers),
      auth: normAuth(doc.auth),
      body: { type: str(doc.body?.type) || 'none', content: str(doc.body?.content), fields: normKv(doc.body?.fields) },
      scripts: normScripts(doc.scripts),
      docs: str(doc.docs),
      seq: doc.seq,
    },
  };
}

export function serializeRequest(r) {
  let body;
  const t = r.body?.type || 'none';
  if (t === 'form' || t === 'multipart') body = prune({ type: t, fields: cleanKv(r.body.fields) });
  else if (t !== 'none') body = prune({ type: t, content: r.body.content });
  return dump(
    prune({
      name: r.name,
      method: r.method || 'GET',
      url: r.url ?? '',
      params: cleanKv(r.params),
      headers: cleanKv(r.headers),
      auth: cleanAuth(r.auth),
      body,
      scripts: cleanScripts(r.scripts),
      docs: r.docs,
      seq: r.seq,
    }),
  );
}

// ------------------------------------------------------------ folder

export function parseFolder(text) {
  const { doc, error } = parseYaml(text);
  if (error) return { doc: null, error };
  return {
    error: null,
    doc: {
      name: str(doc.name),
      variables: mapToKv(doc.variables),
      headers: normKv(doc.headers),
      auth: normAuth(doc.auth),
      scripts: normScripts(doc.scripts),
    },
  };
}

export function serializeFolder(f) {
  const out = prune({
    name: f.name,
    variables: kvToMap(f.variables),
    headers: cleanKv(f.headers),
    auth: cleanAuth(f.auth),
    scripts: cleanScripts(f.scripts),
  });
  return Object.keys(out).length ? dump(out) : '';
}

// ------------------------------------------------------------ collection

export function parseCollection(text) {
  const { doc, error } = parseYaml(text);
  if (error) return { doc: null, error };
  const s = doc.settings || {};
  return {
    error: null,
    doc: {
      version: doc.version || 1,
      name: str(doc.name),
      settings: {
        commitEnvironments: !!s.commitEnvironments,
        timeoutMs: s.timeoutMs ?? '',
        scriptTimeoutMs: s.scriptTimeoutMs ?? '',
        followRedirects: s.followRedirects !== false,
        verifyTls: s.verifyTls !== false,
      },
      variables: mapToKv(doc.variables),
      headers: normKv(doc.headers),
      auth: normAuth(doc.auth?.type ? doc.auth : { type: 'none' }),
      scripts: normScripts(doc.scripts),
    },
  };
}

export function serializeCollection(c) {
  const s = c.settings;
  const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? undefined : Number(v));
  return dump(
    prune({
      version: c.version || 1,
      name: c.name,
      settings: prune({
        commitEnvironments: s.commitEnvironments || undefined,
        timeoutMs: num(s.timeoutMs),
        scriptTimeoutMs: num(s.scriptTimeoutMs),
        followRedirects: s.followRedirects ? undefined : false,
        verifyTls: s.verifyTls ? undefined : false,
      }),
      variables: kvToMap(c.variables),
      headers: cleanKv(c.headers),
      auth: c.auth?.type === 'none' ? undefined : cleanAuth(c.auth, false),
      scripts: cleanScripts(c.scripts),
    }),
  );
}

// ------------------------------------------------------------ workflow

export function parseWorkflow(text) {
  const { doc, error } = parseYaml(text);
  if (error) return { doc: null, error };
  const s = doc.settings || {};
  return {
    error: null,
    doc: {
      name: str(doc.name),
      data: str(doc.data),
      steps: (Array.isArray(doc.steps) ? doc.steps : []).map((st) => ({
        name: str(st?.name),
        request: str(st?.request),
        if: str(st?.if),
        scripts: normScripts(st?.scripts),
      })),
      scripts: normScripts(doc.scripts),
      settings: { stopOnFailure: !!s.stopOnFailure, delayMs: s.delayMs ?? '', maxIterations: s.maxIterations ?? '' },
    },
  };
}

export function serializeWorkflow(w) {
  const num = (v) => (v === '' || v == null || isNaN(Number(v)) || Number(v) === 0 ? undefined : Number(v));
  return dump(
    prune({
      name: w.name,
      data: w.data,
      settings: prune({
        stopOnFailure: w.settings.stopOnFailure || undefined,
        delayMs: num(w.settings.delayMs),
        maxIterations: num(w.settings.maxIterations),
      }),
      scripts: cleanScripts(w.scripts),
      steps: w.steps.map((s) => ({ name: s.name, request: s.request, ...prune({ if: s.if, scripts: cleanScripts(s.scripts) }) })),
    }),
  );
}

// ------------------------------------------------------------ environments (.env)

function parseEnvLine(line) {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('export ')) s = s.slice(7);
  const i = s.indexOf('=');
  if (i <= 0) return null;
  const key = s.slice(0, i).trim();
  let v = s.slice(i + 1).trim();
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
  } else if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) {
    v = v.slice(1, -1);
  } else {
    const j = v.indexOf(' #');
    if (j >= 0) v = v.slice(0, j).trim();
  }
  return [key, v];
}

export function parseEnv(text) {
  const out = [];
  const seen = new Map();
  for (const line of (text || '').split('\n')) {
    const kv = parseEnvLine(line);
    if (!kv) continue;
    if (seen.has(kv[0])) out[seen.get(kv[0])].value = kv[1];
    else {
      seen.set(kv[0], out.length);
      out.push({ key: kv[0], value: kv[1] });
    }
  }
  return out;
}

export function formatEnvValue(v) {
  if (v === '') return '';
  if (/["'#\\\n\r\t]/.test(v) || v.trim() !== v) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }
  return v;
}

/** Writes the given rows into an env text, keeping comments and order. */
export function updateEnv(text, rows) {
  const wanted = new Map();
  for (const r of rows) if (r.key.trim()) wanted.set(r.key.trim(), r.value);
  const done = new Set();
  const out = [];
  for (const line of (text || '').split('\n')) {
    const kv = parseEnvLine(line);
    if (!kv) {
      out.push(line);
      continue;
    }
    if (!wanted.has(kv[0]) || done.has(kv[0])) continue;
    done.add(kv[0]);
    out.push(`${kv[0]}=${formatEnvValue(wanted.get(kv[0]))}`);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const [k, v] of wanted) if (!done.has(k)) out.push(`${k}=${formatEnvValue(v)}`);
  return out.join('\n') + '\n';
}

export const envName = (path) => path.split('/').pop().replace(/\.env(\.pub)?$/, '');
export const isPublicEnv = (path) => path.endsWith('.env.pub');
export const isEnvFile = (path) => path.startsWith('environments/') && /\.env(\.pub)?$/.test(path);

// ------------------------------------------------------------ git

const GIT_BEGIN = '# >>> POSTBote (managed block, edit via collection settings) >>>';
const GIT_END = '# <<< POSTBote <<<';

export function gitignoreBlock(commitEnvironments) {
  return commitEnvironments
    ? [GIT_BEGIN, '# all environments are committed (settings.commitEnvironments: true)', GIT_END]
    : [GIT_BEGIN, '# private environments stay local, public ones (*.env.pub) are committed', '*.env', GIT_END];
}

export function updateGitignore(text, commitEnvironments) {
  const lines = (text || '').split('\n');
  const a = lines.indexOf(GIT_BEGIN);
  const b = lines.indexOf(GIT_END);
  const block = gitignoreBlock(commitEnvironments);
  let out;
  if (a >= 0 && b > a) out = [...lines.slice(0, a), ...block, ...lines.slice(b + 1)];
  else out = [...block, '', ...lines];
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------ misc

export function slug(s) {
  const out = String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return out || 'untitled';
}

export function uniquePath(files, dir, base, ext) {
  let p = `${dir}/${base}${ext}`;
  for (let i = 2; p in files; i++) p = `${dir}/${base}-${i}${ext}`;
  return p;
}

export const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const basename = (p) => p.split('/').pop();

/** Files of a freshly created collection. */
export function scaffold(name) {
  return {
    [MANIFEST]: serializeCollection({
      version: 1,
      name,
      settings: { commitEnvironments: false, timeoutMs: '', scriptTimeoutMs: '', followRedirects: true, verifyTls: true },
      variables: [{ key: 'baseUrl', value: 'https://httpbin.org' }],
      headers: [],
      auth: { type: 'none' },
      scripts: { pre: '', post: '' },
    }),
    '.gitignore': updateGitignore('', false),
    'environments/local.env': '# private environment, not committed (see .gitignore)\ntoken=\n',
    'environments/shared.env.pub': '# public environment, committed to git: no secrets here\nbaseUrl=https://httpbin.org\n',
    'requests/examples/_folder.yaml': serializeFolder({ name: 'Examples', variables: [], headers: [], auth: { type: 'inherit' }, scripts: {} }),
    'requests/examples/get-json.req.yaml': serializeRequest({
      name: 'Get JSON',
      method: 'GET',
      url: '{{baseUrl}}/json',
      params: [],
      headers: [{ key: 'Accept', value: 'application/json' }],
      auth: { type: 'inherit' },
      body: { type: 'none' },
      scripts: {
        pre: '',
        post: "test('status is 200', () => expect(res.status).toBe(200));\ntest('has a slideshow', () => expect(res.json()).toHaveProperty('slideshow'));\n",
      },
    }),
    'README.md': `# ${name}\n\nAPI collection for [postbote](https://github.com/). Everything is plain text:\n\n- \`postbote.yaml\` collection settings, variables, scripts\n- \`requests/**/*.req.yaml\` requests, \`_folder.yaml\` folder settings\n- \`workflows/*.flow.yaml\` workflows\n- \`environments/*.env\` private environments (gitignored), \`*.env.pub\` public ones\n`,
  };
}
