// The request as it would be sent: inherited headers/auth from collection
// and folders, params, auth and variables applied. Pre-request scripts are
// not executed here (they may have side effects).
import { MANIFEST, FOLDER_FILE, parseCollection, parseFolder } from './format.js';
import { variableScope, interpolate, ancestors } from './vars.js';

const enabled = (kvs) => (kvs || []).filter((r) => r.key && !r.disabled);

function b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// keep {{placeholders}} readable inside encoded query strings
const enc = (s) => encodeURIComponent(s).replace(/%7B%7B(.*?)%7D%7D/g, (_, n) => `{{${decodeURIComponent(n)}}}`);

export function effectiveRequest(files, env, reqPath, doc, { resolve = true } = {}) {
  const scope = variableScope(files, env, reqPath);
  const I = (s) => (resolve ? interpolate(s, scope) : String(s ?? ''));
  const col = parseCollection(files[MANIFEST] || '').doc;
  const folders = ancestors(reqPath)
    .map((d) => files[`${d}/${FOLDER_FILE}`])
    .filter(Boolean)
    .map((t) => parseFolder(t).doc)
    .filter(Boolean);

  const headers = [];
  const has = (name) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  const merge = (kvs) => {
    for (const r of enabled(kvs)) {
      const i = headers.findIndex(([k]) => k.toLowerCase() === r.key.toLowerCase());
      if (i >= 0) headers[i] = [r.key, r.value];
      else headers.push([r.key, r.value]);
    }
  };
  merge(col?.headers);
  folders.forEach((f) => merge(f.headers));
  merge(doc.headers);
  for (const h of headers) {
    h[0] = I(h[0]);
    h[1] = I(h[1]);
  }

  const explicit = (a) => (a && a.type && a.type !== 'inherit' ? a : null);
  let auth = explicit(doc.auth);
  for (const f of [...folders].reverse()) auth ??= explicit(f.auth);
  auth ??= explicit(col?.auth);

  let url = I(doc.url).trim();
  if (url && !url.includes('://')) url = 'http://' + url;
  const query = enabled(doc.params).map((p) => [I(p.key), I(p.value)]);
  if (auth?.type === 'bearer' && !has('authorization')) headers.push(['Authorization', `Bearer ${I(auth.token)}`]);
  if (auth?.type === 'basic' && !has('authorization')) {
    const cred = `${I(auth.username)}:${I(auth.password)}`;
    headers.push(['Authorization', /\{\{/.test(cred) ? `Basic base64(${cred})` : `Basic ${b64(cred)}`]);
  }
  if (auth?.type === 'apikey' && auth.key) {
    if (auth.in === 'query') query.push([I(auth.key), I(auth.value)]);
    else if (!has(auth.key)) headers.push([I(auth.key), I(auth.value)]);
  }
  if (query.length) url += (url.includes('?') ? '&' : '?') + query.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');

  const type = doc.body?.type || 'none';
  const body = { type, content: '', fields: [], file: '' };
  if (type === 'file' && doc.body?.file) {
    body.file = I(doc.body.file); // sent as raw bytes; content type from the extension
  } else if (type === 'form' || type === 'multipart') {
    body.fields = enabled(doc.body.fields).map((f) => ({ key: I(f.key), value: I(f.value), file: f.file ? I(f.file) : '' }));
  } else if (type !== 'none' && doc.body?.content) {
    body.content = I(doc.body.content);
    const ct = { json: 'application/json', xml: 'application/xml', text: 'text/plain; charset=utf-8' }[type];
    if (ct && !has('content-type')) headers.push(['Content-Type', ct]);
  } else {
    body.type = 'none';
  }

  const scripted = !!(col?.scripts.pre || folders.some((f) => f.scripts.pre) || doc.scripts?.pre);
  const unresolved = [...new Set([url, ...headers.flat(), body.content, ...body.fields.map((f) => f.value)].join('\n').match(/\{\{\s*[^{}]+?\s*\}\}/g) || [])];
  return { method: doc.method || 'GET', url, headers, body, scripted, unresolved };
}
