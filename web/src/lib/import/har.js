// HAR 1.2 (browser DevTools "Save all as HAR") → a new collection with one
// folder per host. Static assets are skipped when the browser marked the
// resource type; browser-managed headers are dropped or imported disabled.
import { slug } from '../format.js';

const isHar = (j) => !!j && typeof j === 'object' && !!j.log && Array.isArray(j.log.entries);

export const har = {
  id: 'har',
  label: 'HAR (browser network log)',
  accept: ['.har', '.json'],
  detect: (input) => isHar(input.json),
  parse: parseHar,
};

const kv = (key, value, disabled = false) => ({ key: String(key), value: String(value ?? ''), file: '', disabled });
// set by the browser itself, or HTTP/2 pseudo headers: dropped
const DROP = /^(:.*|host|content-length|connection|accept-encoding|cookie)$/i;
// sent by the browser, rarely wanted in a saved request: kept but disabled
const NOISE = /^(sec-ch-|sec-fetch-|sec-gpc$|priority$|upgrade-insecure-requests$|dnt$|pragma$|cache-control$|user-agent$|referer$|origin$|accept-language$)/i;
const API_TYPES = new Set(['xhr', 'fetch', 'document', 'websocket', 'eventsource', 'other', 'preflight', 'ping']);

export function parseHar(inputs) {
  const input = inputs.find((i) => isHar(i.json));
  if (!input) throw new Error('No HAR file among the selected files.');
  const warnings = [];
  const folders = new Map(); // host → folder path
  const requests = [];
  let skipped = 0;
  let cookies = 0;
  const seen = new Set();

  for (const e of input.json.log.entries) {
    const r = e?.request;
    if (!r?.url || !r.method) continue;
    const type = String(e._resourceType || '').toLowerCase();
    if (type && !API_TYPES.has(type)) {
      skipped++; // images, scripts, styles, fonts, …
      continue;
    }
    if (r.method === 'OPTIONS' && type === 'preflight') continue;
    let url;
    try {
      url = new URL(r.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const key = `${r.method} ${url.origin}${url.pathname}${url.search} ${r.postData?.text || ''}`;
    if (seen.has(key)) continue; // repeated identical calls (polling)
    seen.add(key);

    if (!folders.has(url.host)) folders.set(url.host, `requests/${slug(url.host.replace(/\./g, '-'))}`);
    const headers = [];
    for (const h of r.headers || []) {
      if (!h?.name) continue;
      if (/^cookie$/i.test(h.name)) cookies++;
      if (DROP.test(h.name)) continue;
      headers.push(kv(h.name, h.value, NOISE.test(h.name)));
    }
    const params = (r.queryString || []).map((q) => kv(q.name, decodeSafe(q.value)));

    let body = { type: 'none', content: '', fields: [] };
    const pd = r.postData;
    if (pd) {
      const mime = String(pd.mimeType || '').toLowerCase();
      if (Array.isArray(pd.params) && pd.params.length) {
        const multipart = mime.includes('multipart');
        body = { type: multipart ? 'multipart' : 'form', content: '', fields: pd.params.map((p) => ({ ...kv(p.name, p.fileName ? '' : decodeSafe(p.value)), file: p.fileName ? String(p.fileName) : '' })) };
        if (pd.params.some((p) => p.fileName)) warnings.push(`${r.method} ${url.pathname}: form files must be put into the collection`);
      } else if (pd.text) {
        let content = pd.text;
        if (mime.includes('json') || /^\s*[[{]/.test(content)) {
          try {
            content = JSON.stringify(JSON.parse(content), null, 2);
          } catch {
            // keep as recorded
          }
          body = { type: 'json', content, fields: [] };
        } else if (mime.includes('x-www-form-urlencoded')) {
          body = { type: 'form', content: '', fields: [...new URLSearchParams(content)].map(([k, v]) => kv(k, v)) };
        } else if (mime.includes('xml')) body = { type: 'xml', content, fields: [] };
        else body = { type: 'text', content, fields: [] };
      }
      // the body type sets these again when sending
      if (body.type !== 'text' && body.type !== 'xml') {
        const i = headers.findIndex((h) => /^content-type$/i.test(h.key));
        if (i >= 0 && (body.type !== 'json' || /^application\/json\s*(;.*)?$/i.test(headers[i].value))) headers.splice(i, 1);
      }
    }

    // Authorization: Bearer x → auth
    let auth = { type: 'inherit' };
    const ai = headers.findIndex((h) => /^authorization$/i.test(h.key) && /^bearer\s+\S+$/i.test(h.value));
    if (ai >= 0) {
      auth = { type: 'bearer', token: headers[ai].value.replace(/^bearer\s+/i, '') };
      headers.splice(ai, 1);
    }

    const status = e.response?.status ? ` → ${e.response.status}` : '';
    requests.push({
      dir: folders.get(url.host),
      doc: {
        name: `${r.method} ${url.pathname}`.slice(0, 80),
        method: r.method.toUpperCase(),
        url: `${url.origin}${url.pathname}`,
        params,
        headers,
        auth,
        body,
        scripts: {},
        docs: `Recorded ${e.startedDateTime || ''}${status}`.trim(),
      },
    });
  }
  if (skipped) warnings.push(`${skipped} static resource${skipped > 1 ? 's' : ''} (images, scripts, styles, …) skipped`);
  if (cookies) warnings.push('Cookie headers were not imported: log in with a request instead (the cookie jar keeps the session)');
  if (!requests.length) warnings.push('The HAR file contains no API requests');
  const hosts = [...folders.keys()];
  return {
    name: hosts.length === 1 ? hosts[0] : `HAR ${input.name.replace(/\.(har|json)$/i, '')}`,
    docs: `Recorded with ${input.json.log.creator?.name || 'a browser'}${input.json.log.creator?.version ? ` ${input.json.log.creator.version}` : ''}.`,
    collection: { variables: [], headers: [], scripts: {} },
    folders: hosts.map((h) => ({ path: folders.get(h), doc: { name: h } })),
    requests,
    environments: [],
    warnings,
  };
}

function decodeSafe(v) {
  try {
    return decodeURIComponent(String(v ?? '').replace(/\+/g, ' '));
  } catch {
    return String(v ?? '');
  }
}
