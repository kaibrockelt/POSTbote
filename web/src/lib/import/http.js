// .http / .rest files (JetBrains HTTP Client, VS Code REST Client) → a new
// collection; the JetBrains environment files http-client.env.json and
// http-client.private.env.json can be selected together with them. A single
// pasted request ("GET https://… HTTP/1.1" plus headers and body) is a request
// importer of its own.
import { slug } from '../format.js';

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT';
const REQUEST_LINE = new RegExp(`^(${METHODS})\\s+(\\S.*?)(?:\\s+HTTP\\/[\\d.]+)?\\s*$`, 'i');
const isHttpFile = (i) => /\.(http|rest)$/i.test(i.name);
const isEnvJson = (i) => /http-client(\.private)?\.env\.json$/i.test(i.name) && i.json && typeof i.json === 'object';

export const httpFile = {
  id: 'http',
  label: '.http / .rest files (JetBrains, VS Code)',
  accept: ['.http', '.rest', '.json'],
  detect: (input) => isHttpFile(input),
  parse: parseHttpFiles,
};

export const rawHttp = {
  id: 'raw-http',
  label: 'raw HTTP request',
  detect: (text) => REQUEST_LINE.test(text.split('\n')[0].trim()) || /^https?:\/\/\S+$/i.test(text.trim()),
  parse: (text) => {
    const warnings = [];
    const [req] = parseBlocks(text, warnings);
    if (!req) throw new Error('No request found');
    return { doc: req.doc, warnings };
  },
};

const kv = (key, value, extra = {}) => ({ key, value, file: '', disabled: false, ...extra });

/** Splits a file into requests; `vars` collects `@name = value` file variables. */
function parseBlocks(text, warnings, vars = new Map()) {
  // requests are separated by lines starting with ###; the rest of that line names the request
  const blocks = [{ title: '', lines: [] }];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (/^###/.test(line)) blocks.push({ title: line.replace(/^#+\s*/, '').trim(), lines: [] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks.map((b) => parseBlock(b.lines.join('\n'), warnings, vars, b.title)).filter(Boolean);
}

function parseBlock(block, warnings, vars, title = '') {
  const lines = block.split('\n');
  let name = title;
  let i = 0;
  const pre = [];
  // comments, @name / @variables and pre-request scripts before the request line
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const named = l.match(/^(?:#|\/\/)\s*@name\s+(.+)$/);
    if (named) {
      name = named[1].trim();
      continue;
    }
    const fileVar = l.match(/^@([\w.-]+)\s*=\s*(.*)$/);
    if (fileVar) {
      vars.set(fileVar[1], fileVar[2].trim());
      continue;
    }
    if (/^</.test(l) && l.includes('{%')) {
      const [code, next] = script(lines, i, '<');
      pre.push(code);
      i = next;
      continue;
    }
    if (/^(#|\/\/)/.test(l)) {
      if (!name && /^(#|\/\/)\s*\S/.test(l) && !/^(#|\/\/)\s*@/.test(l)) name = l.replace(/^(#|\/\/)\s*/, '');
      continue;
    }
    break;
  }
  if (i >= lines.length) return null;

  // request line: METHOD URL [HTTP/1.1] or just a URL (GET); query continuation lines follow
  let first = lines[i].trim();
  let method = 'GET';
  let url = first;
  const m = first.match(REQUEST_LINE);
  if (m) {
    method = m[1].toUpperCase();
    url = m[2].trim();
  } else if (!/^(https?:\/\/|\{\{)/i.test(first)) {
    warnings.push(`Skipped a block that does not start with a request line: “${first.slice(0, 60)}”`);
    return null;
  }
  for (i++; i < lines.length && /^\s+[?&]/.test(lines[i]); i++) url += lines[i].trim();

  const headers = [];
  for (; i < lines.length && lines[i].trim(); i++) {
    const h = lines[i].trim();
    if (/^(#|\/\/)/.test(h)) continue;
    const c = h.indexOf(':');
    if (c > 0) headers.push(kv(h.slice(0, c).trim(), h.slice(c + 1).trim()));
  }

  // body until a response handler (> …) or response reference (<> …)
  const body = [];
  const post = [];
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (/^>\s*\{%/.test(l.trim())) {
      const [code, next] = script(lines, i, '>');
      post.push(code);
      i = next;
      continue;
    }
    if (/^>\s*\S/.test(l.trim())) {
      warnings.push(`Response handler file ${l.trim().slice(1).trim()} is not imported`);
      continue;
    }
    if (/^<>/.test(l.trim())) continue;
    body.push(l);
  }
  const content = body.join('\n').trim();

  // query string → params
  const params = [];
  const q = url.indexOf('?');
  if (q >= 0) {
    for (const p of url.slice(q + 1).split('&').filter(Boolean)) {
      const e = p.indexOf('=');
      params.push(e < 0 ? kv(p, '') : kv(p.slice(0, e), p.slice(e + 1)));
    }
    url = url.slice(0, q);
  }

  const ct = (headers.find((h) => /^content-type$/i.test(h.key))?.value || '').toLowerCase();
  let b = { type: 'none', content: '', fields: [] };
  const fileRef = content.match(/^<\s+(\S+)$/);
  if (fileRef) {
    b = { type: 'file', content: '', fields: [], file: fileRef[1].replace(/^\.\//, '') };
    warnings.push(`Body file ${b.file} must exist in the collection`);
  } else if (content) {
    if (ct.includes('json') || (!ct && /^[[{]/.test(content))) b = { type: 'json', content, fields: [] };
    else if (ct.includes('x-www-form-urlencoded')) {
      b = {
        type: 'form',
        content: '',
        fields: content
          .replace(/\n\s*&/g, '&')
          .split('&')
          .filter(Boolean)
          .map((p) => {
            const e = p.indexOf('=');
            return e < 0 ? kv(p.trim(), '') : kv(p.slice(0, e).trim(), p.slice(e + 1).trim());
          }),
      };
    } else if (ct.includes('xml')) b = { type: 'xml', content, fields: [] };
    else b = { type: 'text', content, fields: [] };
    if (ct.includes('multipart')) warnings.push(`${method} ${url}: multipart body was imported as text`);
  }
  if (b.type === 'json' || b.type === 'form') {
    const i2 = headers.findIndex((h) => /^content-type$/i.test(h.key) && /^(application\/json|application\/x-www-form-urlencoded)\s*(;.*)?$/i.test(h.value));
    if (i2 >= 0) headers.splice(i2, 1);
  }

  // Authorization: Bearer x → auth, like the other importers
  let auth = { type: 'inherit' };
  const ai = headers.findIndex((h) => /^authorization$/i.test(h.key) && /^bearer\s+\S+$/i.test(h.value));
  if (ai >= 0) {
    auth = { type: 'bearer', token: headers[ai].value.replace(/^bearer\s+/i, '') };
    headers.splice(ai, 1);
  }

  const asComment = (title, code) => `// ${title} (HTTP client script, not converted):\n${code.split('\n').map((l) => `// ${l}`.trimEnd()).join('\n')}\n`;
  const path = url.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/^\{\{[^}]+\}\}/, '') || '/';
  return {
    doc: {
      name: name || `${method} ${path}`.slice(0, 80),
      method,
      url: jetbrainsVars(url),
      params: params.map((p) => ({ ...p, value: jetbrainsVars(p.value) })),
      headers: headers.map((h) => ({ ...h, value: jetbrainsVars(h.value) })),
      auth,
      body: { ...b, content: jetbrainsVars(b.content) },
      scripts: { pre: pre.length ? asComment('pre-request', pre.join('\n')) : '', post: post.length ? asComment('response handler', post.join('\n')) : '' },
      docs: '',
    },
  };
}

/** Text between {% and %} starting at line i; returns [code, last line index]. */
function script(lines, i, marker) {
  let text = lines[i].trim().replace(new RegExp(`^\\${marker}\\s*\\{%`), '');
  let j = i;
  while (!text.includes('%}') && j + 1 < lines.length) text += '\n' + lines[++j];
  return [text.replace(/%\}\s*$/, '').trim(), j];
}

// JetBrains names some dynamic variables differently
const jetbrainsVars = (s) =>
  String(s || '')
    .replace(/\{\{\s*\$random\.uuid\s*\}\}/g, '{{$uuid}}')
    .replace(/\{\{\s*\$uuid\s*\}\}/g, '{{$uuid}}')
    .replace(/\{\{\s*\$timestamp\s*\}\}/g, '{{$timestamp}}')
    .replace(/\{\{\s*\$isoTimestamp\s*\}\}/g, '{{$isoTimestamp}}')
    .replace(/\{\{\s*\$random\.integer\(\s*\)\s*\}\}/g, '{{$randomInt}}');

export function parseHttpFiles(inputs) {
  const files = inputs.filter(isHttpFile);
  const warnings = [];
  const vars = new Map();
  const requests = [];
  const folders = [];
  const several = files.length > 1;
  for (const f of files) {
    const dir = several ? `requests/${slug(f.name.replace(/\.(http|rest)$/i, ''))}` : 'requests';
    if (several) folders.push({ path: dir, doc: { name: f.name.replace(/\.(http|rest)$/i, '') } });
    for (const r of parseBlocks(f.text, warnings, vars)) requests.push({ dir, doc: r.doc });
  }

  // http-client.env.json (shared) + http-client.private.env.json (private), keyed by environment
  const envs = new Map();
  for (const i of inputs.filter(isEnvJson)) {
    const priv = /\.private\./i.test(i.name);
    for (const [env, values] of Object.entries(i.json)) {
      if (!values || typeof values !== 'object') continue;
      const list = envs.get(env) || [];
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === 'object') continue; // e.g. SSL configuration
        const at = list.findIndex((x) => x.key === k);
        const entry = { key: k, value: String(v), secret: priv };
        if (at >= 0) list[at] = priv ? entry : { ...entry, secret: list[at].secret };
        else list.push(entry);
      }
      envs.set(env, list);
    }
  }
  for (const i of inputs) if (!isHttpFile(i) && !isEnvJson(i)) warnings.push(`${i.name}: ignored (not a .http file or http-client env file)`);
  // VS Code request variables ({{login.response.body.$.token}}) need a script here
  const chained = new Set(JSON.stringify(requests).match(/\{\{\s*[\w-]+\.(response|request)\.[^}]*\}\}/g) || []);
  if (chained.size) warnings.push(`Request variables like ${[...chained][0]} are not resolved: set them with vars.set() in a post-response script`);
  const unique = [...new Set(warnings)];
  const first = files[0]?.name.replace(/\.(http|rest)$/i, '') || 'HTTP requests';
  return {
    name: several ? 'HTTP requests' : first,
    docs: `Imported from ${files.map((f) => f.name).join(', ')}.`,
    collection: { variables: [...vars].map(([key, value]) => kv(key, jetbrainsVars(value))), headers: [], scripts: {} },
    folders,
    requests,
    environments: [...envs].map(([name, values]) => ({ name, values })),
    warnings: unique,
  };
}
