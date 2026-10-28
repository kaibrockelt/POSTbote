// OpenAPI 3.0 / 3.1 / 3.2 and Swagger 2.0 (JSON or YAML) → a new collection.
// A spec describes an API, not a collection: every operation becomes a
// request, tags become folders, servers become environments (baseUrl) and
// security schemes become collection auth with the secrets declared in the
// environments. Bodies come from examples or are generated from schemas.
import { slug } from '../format.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const isSpec = (j) => !!j && typeof j === 'object' && (/^3\./.test(String(j.openapi)) || String(j.swagger) === '2.0');

export const openapi = {
  id: 'openapi',
  label: 'OpenAPI 3.x / Swagger 2.0',
  accept: ['.json', '.yaml', '.yml'],
  detect: (input) => isSpec(input.json),
  parse: parseOpenApi,
};

const kv = (key, value, disabled = false, extra = {}) => ({ key: String(key), value: value == null ? '' : String(value), file: '', disabled: !!disabled, ...extra });
const scalar = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function parseOpenApi(inputs) {
  const main = inputs.find((i) => isSpec(i.json));
  if (!main) throw new Error('No OpenAPI or Swagger document among the selected files.');
  const spec = main.json;
  const v2 = String(spec.swagger) === '2.0';
  const warnings = new Set();
  // other selected files can satisfy external $refs (./schemas/pet.yaml#/Pet)
  const docs = new Map(inputs.filter((i) => i.json && typeof i.json === 'object').map((i) => [i.name.split(/[\\/]/).pop(), i.json]));
  const ctx = { spec, v2, warnings, docs, collectionVars: new Map(), skipped: { callbacks: 0, webhooks: 0 }, incoming: [] };

  const name = String(spec.info?.title || main.name.replace(/\.(json|ya?ml)$/i, '') || 'API');
  const { environments, baseUrl } = convertServers(ctx);
  const docLines = [
    spec.info?.description,
    spec.info?.version && `Version ${spec.info.version}`,
    spec.externalDocs?.url && `More: ${spec.externalDocs.url}`,
    ctx.serverNotes?.length && `Server variables (set in the environments):\n\n${ctx.serverNotes.join('\n')}`,
  ];
  const security = convertSecurity(ctx);

  const folders = folderPlan(ctx);
  const requests = [];
  for (const [path, item] of Object.entries(deref(ctx, spec.paths || {}))) {
    const pathItem = deref(ctx, item) || {};
    // methods in the order of the document
    for (const method of Object.keys(pathItem).filter((m) => METHODS.includes(m))) {
      const op = pathItem[method];
      if (!op) continue;
      const doc = convertOperation(ctx, path, method, pathItem, op, security);
      const tag = (op.tags || [])[0];
      requests.push({ dir: tag ? folders.dirOf(tag) : 'requests', doc, order: requests.length });
      for (const [cbName, cb] of Object.entries(op.callbacks || {})) {
        ctx.skipped.callbacks++;
        for (const [expr, item] of Object.entries(deref(ctx, cb) || {})) {
          ctx.incoming.push(`- Callback \`${cbName}\` of \`${method.toUpperCase()} ${path}\`: ${describeIncoming(ctx, item)} to \`${expr}\``);
        }
      }
    }
  }
  for (const [hook, item] of Object.entries(spec.webhooks || {})) {
    ctx.skipped.webhooks++;
    ctx.incoming.push(`- Webhook \`${hook}\`: ${describeIncoming(ctx, item)}`);
  }

  // declare the secrets of all used security schemes (also per operation) in
  // every environment; they need one to live in
  const plain = [...security.plain];
  const secrets = [...security.secrets];
  if (!environments.length && secrets.length) environments.push({ name: 'default', values: [{ key: 'baseUrl', value: baseUrl, secret: false }] });
  for (const env of environments) {
    env.values.push(...plain.map((key) => ({ key, value: '', secret: false })), ...secrets.map((key) => ({ key, value: '', secret: true })));
  }

  const variables = [kv('baseUrl', baseUrl), ...[...ctx.collectionVars].map(([k, v]) => kv(k, v))];
  // requests the API sends to you cannot be run from here: they are documented in the README
  const n = ctx.skipped.callbacks + ctx.skipped.webhooks;
  if (n) warnings.add(`${n} callback${n > 1 ? 's/webhooks are' : '/webhook is'} described in the README (requests the API sends to you)`);
  if (ctx.incoming.length) docLines.push(`## Callbacks and webhooks\n\nRequests this API sends to you:\n\n${ctx.incoming.join('\n')}`);
  if (!requests.length) warnings.add('The document contains no operations');

  return {
    name,
    docs: docLines.filter(Boolean).join('\n\n'),
    collection: { variables, headers: [], auth: security.auth, scripts: {} },
    folders: folders.list(requests),
    requests: requests.map(({ dir, doc }) => ({ dir, doc })),
    environments,
    warnings: [...warnings],
  };
}

// ------------------------------------------------------------------ $ref

/** Follows $ref chains (local and, if the file was selected too, external). */
function deref(ctx, node, seen = new Set()) {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string') return node;
  const ref = node.$ref;
  if (seen.has(ref)) return {};
  seen.add(ref);
  const [file, pointer = ''] = ref.split('#');
  let root = ctx.spec;
  if (file) {
    root = ctx.docs.get(file.split(/[\\/]/).pop());
    if (!root) {
      ctx.warnings.add(`External reference ${ref} was not resolved (select that file together with the spec)`);
      return {};
    }
  }
  let target = root;
  for (const part of pointer.split('/').slice(1)) {
    target = target?.[decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'))];
  }
  if (target === undefined) {
    ctx.warnings.add(`Reference ${ref} points nowhere`);
    return {};
  }
  // 3.1 allows siblings next to $ref (e.g. a description); they win
  const { $ref, ...siblings } = node;
  const resolved = deref(ctx, target, seen);
  return Object.keys(siblings).length && resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? { ...resolved, ...siblings } : resolved;
}

// ------------------------------------------------------------------ servers

function convertServers(ctx) {
  const { spec, v2, warnings } = ctx;
  let servers = [];
  if (v2) {
    if (spec.host) {
      const scheme = (spec.schemes || []).includes('https') || !spec.schemes?.length ? 'https' : spec.schemes[0];
      servers = [{ url: `${scheme}://${spec.host}${spec.basePath || ''}` }];
    } else if (spec.basePath) servers = [{ url: spec.basePath }];
  } else {
    servers = (spec.servers || []).filter((s) => s && s.url);
  }
  if (!servers.length) {
    warnings.add('No server URL in the document: set baseUrl in the collection variables');
    return { environments: [], baseUrl: 'http://localhost' };
  }

  // {region} server variables become {{region}} in the environment's baseUrl,
  // with their default as value; the choices go to the README
  const urlOf = (s) => {
    const vars = Object.entries(s.variables || {}).map(([k, v]) => ({ key: k, value: scalar(v?.default ?? v?.enum?.[0]), choices: v?.enum || [] }));
    const template = s.url.replace(/\{([^}]+)\}/g, (_, k) => `{{${k}}}`).replace(/\/+$/, '');
    const plain = s.url.replace(/\{([^}]+)\}/g, (_, k) => vars.find((v) => v.key === k)?.value ?? '').replace(/\/+$/, '');
    return { template, plain, vars };
  };
  ctx.serverNotes = servers
    .filter((s) => s.variables && Object.keys(s.variables).length)
    .map((s) => `- \`${s.url}\`: ${urlOf(s).vars.map((v) => `${v.key} = ${v.value}${v.choices.length > 1 ? ` (${v.choices.join(', ')})` : ''}`).join(', ')}`);
  const first = urlOf(servers[0]);
  if (!/^[a-z]+:\/\//i.test(first.plain)) warnings.add(`Server URL “${servers[0].url}” is relative: prefix baseUrl with the host`);

  const used = new Set();
  const environments = servers.map((s, i) => {
    const u = urlOf(s);
    const host = u.plain.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0].replace(/\./g, '-');
    let envName = slug(s.description || host || `server-${i + 1}`);
    for (let n = 2; used.has(envName); n++) envName = `${slug(s.description || 'server')}-${n}`;
    used.add(envName);
    return {
      name: envName,
      values: [{ key: 'baseUrl', value: u.vars.length ? u.template : u.plain, secret: false }, ...u.vars.map((v) => ({ key: v.key, value: v.value, secret: false }))],
    };
  });
  return { environments, baseUrl: first.plain };
}

// ------------------------------------------------------------------ security

/** Collection auth from the global security requirement; secrets are declared per environment. */
function convertSecurity(ctx) {
  const { spec, v2, warnings } = ctx;
  const schemes = (v2 ? spec.securityDefinitions : spec.components?.securitySchemes) || {};
  const secrets = new Set();
  const plain = new Set(); // declared like secrets, but shared (e.g. the basic auth user)
  const authOf = (name) => {
    const s = deref(ctx, schemes[name]);
    if (!s) return null;
    const type = String(s.type || '').toLowerCase();
    if ((type === 'http' && /^bearer$/i.test(s.scheme)) || type === 'oauth2' || type === 'openidconnect') {
      if (type !== 'http') warnings.add(`Security scheme “${name}” (${s.type}): OAuth flows are not supported yet; imported as bearer token {{token}}`);
      secrets.add('token');
      return { type: 'bearer', token: '{{token}}' };
    }
    if ((type === 'http' && /^basic$/i.test(s.scheme)) || type === 'basic') {
      secrets.add('password');
      plain.add('username');
      return { type: 'basic', username: '{{username}}', password: '{{password}}' };
    }
    if (type === 'apikey') {
      if (s.in === 'cookie') warnings.add(`API key “${s.name}” is sent as a cookie: add it as a Cookie header`);
      secrets.add('apiKey');
      return { type: 'apikey', key: s.name, value: '{{apiKey}}', in: s.in === 'query' ? 'query' : 'header' };
    }
    warnings.add(`Security scheme “${name}” (${s.type}${s.scheme ? ` ${s.scheme}` : ''}) is not supported`);
    return null;
  };
  const fromRequirements = (reqs) => {
    if (!Array.isArray(reqs)) return undefined;
    if (!reqs.length || reqs.some((r) => r && !Object.keys(r).length)) return { type: 'none' }; // [] or {} = public
    for (const r of reqs) for (const n of Object.keys(r || {})) {
      const a = authOf(n);
      if (a) return a;
    }
    return undefined;
  };
  const auth = fromRequirements(spec.security);
  // secrets/plain are live sets: operations add the schemes they use
  return { auth: auth?.type === 'none' ? undefined : auth, secrets, plain, fromRequirements, global: auth };
}

/** "POST (summary)" for the operations of a callback/webhook path item. */
function describeIncoming(ctx, item) {
  const p = deref(ctx, item) || {};
  const ops = Object.keys(p).filter((m) => METHODS.includes(m));
  return ops.map((m) => `${m.toUpperCase()}${p[m]?.summary ? ` (${p[m].summary})` : ''}`).join(', ') || 'request';
}

// ------------------------------------------------------------------ folders

function folderPlan(ctx) {
  const tags = new Map(); // name → { docs, parent }
  for (const t of ctx.spec.tags || []) if (t?.name) tags.set(t.name, { docs: t.description || '', parent: t.parent || '' });
  const dirs = new Map();
  const dirOf = (tag) => {
    if (dirs.has(tag)) return dirs.get(tag);
    const parent = tags.get(tag)?.parent; // OpenAPI 3.2 nested tags
    const base = parent && parent !== tag ? dirOf(parent) : 'requests';
    let dir = `${base}/${slug(tag) || 'tag'}`;
    for (let n = 2; [...dirs.values()].includes(dir); n++) dir = `${base}/${slug(tag)}-${n}`;
    dirs.set(tag, dir);
    return dir;
  };
  return {
    dirOf,
    // folders in the order of the tags list, then as operations used them
    list: (requests) => {
      const used = new Set(requests.map((r) => r.dir));
      for (const t of tags.keys()) if ([...used].some((d) => d === dirs.get(t) || d.startsWith(`${dirs.get(t)}/`))) dirOf(t);
      return [...dirs].filter(([, d]) => [...used].some((u) => u === d || u.startsWith(`${d}/`))).map(([t, d]) => ({ path: d, doc: { name: t }, docs: tags.get(t)?.docs || '' }));
    },
  };
}

// ------------------------------------------------------------------ operations

function convertOperation(ctx, path, method, pathItem, op, security) {
  const where = `${method.toUpperCase()} ${path}`;
  const params = mergeParams(ctx, pathItem.parameters, op.parameters);
  const query = [];
  const headers = [];
  const cookies = [];
  let url = '{{baseUrl}}' + path.replace(/\{([^}]+)\}/g, (_, n) => `{{${n}}}`);
  let body = { type: 'none', content: '', fields: [] };
  const v2form = [];

  for (const p of params) {
    const value = exampleOf(ctx, p);
    switch (p.in) {
      case 'path':
        if (!ctx.collectionVars.has(p.name) || (!ctx.collectionVars.get(p.name) && value)) ctx.collectionVars.set(p.name, value);
        break;
      case 'query':
        query.push(kv(p.name, value, !p.required));
        break;
      case 'header':
        // these are described elsewhere (content types, security)
        if (!/^(accept|content-type|authorization)$/i.test(p.name)) headers.push(kv(p.name, value, !p.required));
        break;
      case 'cookie':
        cookies.push(`${p.name}=${value}`);
        break;
      case 'body': // Swagger 2
        body = { type: 'json', content: jsonText(exampleOf(ctx, p, true)), fields: [] };
        break;
      case 'formData': // Swagger 2
        v2form.push(p);
        break;
    }
  }
  if (cookies.length) headers.push(kv('Cookie', cookies.join('; '), true));

  if (ctx.v2 && v2form.length) {
    const consumes = op.consumes || ctx.spec.consumes || [];
    const multipart = v2form.some((p) => p.type === 'file') || consumes.includes('multipart/form-data');
    body = {
      type: multipart ? 'multipart' : 'form',
      content: '',
      fields: v2form.map((p) => (p.type === 'file' ? kv(p.name, '', !p.required, { file: '' }) : kv(p.name, exampleOf(ctx, p), !p.required))),
    };
  } else if (!ctx.v2 && op.requestBody) {
    body = convertRequestBody(ctx, deref(ctx, op.requestBody), where);
  }

  // own security only when it differs from the collection's
  const reqs = security.fromRequirements(op.security);
  const same = JSON.stringify(reqs) === JSON.stringify(security.global ?? { type: 'none' });
  const auth = reqs === undefined || same ? { type: 'inherit' } : reqs;

  // the operationId is kept so a later re-import can find the request again
  const docs = [op.deprecated && '**Deprecated.**', op.description, op.operationId && `operationId: \`${op.operationId}\``].filter(Boolean).join('\n\n');
  return {
    name: String(op.summary || op.operationId || where).slice(0, 120),
    method: method.toUpperCase(),
    url,
    params: query,
    headers,
    auth,
    body,
    scripts: {},
    docs,
  };
}

function mergeParams(ctx, shared = [], own = []) {
  const out = new Map();
  for (const p of [...(shared || []), ...(own || [])].map((x) => deref(ctx, x)).filter((x) => x && x.name)) out.set(`${p.in}:${p.name}`, p);
  return [...out.values()];
}

function convertRequestBody(ctx, rb, where) {
  const content = rb?.content || {};
  const types = Object.keys(content);
  const pick = (re) => types.find((t) => re.test(t));
  const json = pick(/^application\/(.+\+)?json/i);
  const form = pick(/^application\/x-www-form-urlencoded/i);
  const multi = pick(/^multipart\/form-data/i);
  const xml = pick(/xml/i);
  const text = pick(/^text\//i);
  const none = { type: 'none', content: '', fields: [] };
  if (json) return { type: 'json', content: jsonText(mediaExample(ctx, content[json])), fields: [] };
  if (form || multi) {
    const media = content[form || multi];
    const schema = deref(ctx, media.schema) || {};
    const props = objectProperties(ctx, schema);
    const sample = mediaExample(ctx, media);
    const fields = Object.entries(props)
      .filter(([, s]) => !s.readOnly)
      .map(([k, s]) => {
        const binary = s.format === 'binary' || s.format === 'byte' || s.type === 'file' || s.contentMediaType;
        if (binary && multi) return kv(k, '', false, { file: '' });
        const v = sample && typeof sample === 'object' ? sample[k] : undefined;
        return kv(k, scalar(v ?? sampleOf(ctx, s)));
      });
    return { type: form ? 'form' : 'multipart', content: '', fields };
  }
  if (xml || text) {
    const ex = mediaExample(ctx, content[xml || text], false);
    if (typeof ex !== 'string' && xml) ctx.warnings.add(`${where}: XML body has no example and was left empty`);
    return { type: xml ? 'xml' : 'text', content: typeof ex === 'string' ? ex : '', fields: [] };
  }
  // anything else (octet-stream, images, PDFs, …) is sent as a raw file
  if (types.length) {
    ctx.warnings.add(`${where}: ${types[0]} body – choose the file to send`);
    return { type: 'file', content: '', fields: [], file: '' };
  }
  return none;
}

/** Example of a media type: example, first of examples, else generated from its schema. */
function mediaExample(ctx, media, generate = true) {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  const first = Object.values(media.examples || {})[0];
  if (first !== undefined) {
    const ex = deref(ctx, first);
    if (ex && 'value' in ex) return ex.value;
  }
  return generate ? sampleOf(ctx, media.schema) : undefined;
}

/** Example value for a parameter (as text) or, with `raw`, for a Swagger body. */
function exampleOf(ctx, p, raw = false) {
  if (p.example !== undefined) return raw ? p.example : scalar(p.example);
  const first = Object.values(p.examples || {})[0];
  if (first !== undefined) {
    const ex = deref(ctx, first);
    if (ex && 'value' in ex) return raw ? ex.value : scalar(ex.value);
  }
  // Swagger 2 parameters carry the schema keywords themselves
  const schema = p.schema || (ctx.v2 && p.in !== 'body' ? p : undefined);
  if (raw) return sampleOf(ctx, p.schema);
  if (!schema) return '';
  const s = deref(ctx, schema) || {};
  const v = s.example ?? s.examples?.[0] ?? s.default ?? s.enum?.[0];
  return v === undefined ? '' : scalar(v);
}

function objectProperties(ctx, schema) {
  const s = deref(ctx, schema) || {};
  const props = { ...(s.properties || {}) };
  for (const part of s.allOf || []) Object.assign(props, objectProperties(ctx, part));
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, deref(ctx, v) || {}]));
}

// ------------------------------------------------------------------ samples

const FORMATS = {
  'date-time': '2024-01-01T12:00:00Z',
  date: '2024-01-01',
  time: '12:00:00',
  email: 'user@example.com',
  uuid: '00000000-0000-0000-0000-000000000000',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  password: '',
  byte: '',
  binary: '',
};

/** A plausible value for a JSON schema (request bodies: readOnly properties are left out). */
export function sampleOf(ctx, schema, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return undefined;
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return undefined; // recursive model
    seen = new Set(seen).add(schema.$ref);
  }
  const s = deref(ctx, schema) || {};
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (depth > 6) return undefined;
  if (s.allOf) {
    const parts = s.allOf.map((p) => sampleOf(ctx, p, depth + 1, seen));
    return parts.every((p) => p && typeof p === 'object' && !Array.isArray(p)) ? Object.assign({}, ...parts) : parts.find((p) => p !== undefined);
  }
  const choice = s.oneOf || s.anyOf;
  if (choice?.length) return sampleOf(ctx, choice[0], depth + 1, seen);

  let type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (!type) type = s.properties || s.additionalProperties ? 'object' : s.items ? 'array' : undefined;
  switch (type) {
    case 'object': {
      const out = {};
      const props = Object.entries(s.properties || {});
      for (const [k, v] of props.slice(0, 40)) {
        const pv = deref(ctx, v);
        if (pv?.readOnly) continue;
        const val = sampleOf(ctx, v, depth + 1, seen);
        if (val !== undefined) out[k] = val;
      }
      if (!props.length && s.additionalProperties && typeof s.additionalProperties === 'object') {
        const val = sampleOf(ctx, s.additionalProperties, depth + 1, seen);
        if (val !== undefined) out.key = val;
      }
      return out;
    }
    case 'array': {
      const item = sampleOf(ctx, s.items, depth + 1, seen);
      return item === undefined ? [] : [item];
    }
    case 'string':
      return FORMATS[s.format] ?? 'string';
    case 'integer':
      return s.minimum ?? 0;
    case 'number':
      return s.minimum ?? 0;
    case 'boolean':
      return true;
    default:
      return undefined;
  }
}

/** JSON body text; a string example may already be JSON text, else it is a JSON string value. */
function jsonText(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return JSON.stringify(v);
    }
  }
  return JSON.stringify(v, null, 2);
}
