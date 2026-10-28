// cURL command → request doc. Understands bash/zsh quoting (incl. $'…' from
// "Copy as cURL (bash)"), Windows cmd (^ escapes, "Copy as cURL (cmd)") and
// line continuations (\, ^, PowerShell `).

export const curl = {
  id: 'curl',
  label: 'cURL',
  detect: (text) => /^(curl|curl\.exe)\s/i.test(text.trim()),
  parse: parseCurl,
};

// options that take a value; everything else is a flag
const WITH_VALUE = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-ascii', '--data-raw', '--data-binary', '--data-urlencode', '--json',
  '-F', '--form', '--form-string', '-u', '--user', '-b', '--cookie', '-A', '--user-agent', '-e', '--referer', '--url',
  '--oauth2-bearer', '-o', '--output', '-m', '--max-time', '--connect-timeout', '--retry', '-x', '--proxy', '-c', '--cookie-jar',
  '--cacert', '--cert', '--key', '-w', '--write-out', '--resolve', '--limit-rate', '-T', '--upload-file', '-r', '--range',
]);
// short options whose value may follow directly (-XPOST, -H'…')
const SHORT_WITH_VALUE = new Set([...WITH_VALUE].filter((o) => /^-[a-zA-Z]$/.test(o)).map((o) => o[1]));
const IGNORED = new Set([
  '--compressed', '-L', '--location', '-s', '--silent', '-S', '--show-error', '-v', '--verbose', '-i', '--include', '-f', '--fail',
  '--http1.1', '--http2', '--http2-prior-knowledge', '-#', '--progress-bar', '-N', '--no-buffer', '-o', '--output', '-m', '--max-time',
  '--connect-timeout', '--retry', '-c', '--cookie-jar', '-w', '--write-out', '--limit-rate', '-g', '--globoff', '-n', '--netrc',
]);

/** Splits a shell command line into words. */
export function shellWords(input) {
  let text = String(input).replace(/\r\n/g, '\n');
  const cmd = /\^\s*\n/.test(text) || /\^"/.test(text); // Windows cmd style
  text = text.replace(/\\\n/g, ' ').replace(/\^\n/g, ' ').replace(/`\n/g, ' ');
  // cmd removes ^ escapes first; then quotes group words and \" is a literal quote
  if (cmd) text = text.replace(/\^([\s\S])/g, '$1');
  const words = [];
  let w = null;
  const push = (s) => (w = (w ?? '') + s);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (w !== null) words.push(w);
      w = null;
    } else if (c === "'" && !cmd) {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Error('Unclosed single quote');
      push(text.slice(i + 1, end));
      i = end;
    } else if (c === '$' && text[i + 1] === "'" && !cmd) {
      // ANSI-C quoting: $'line\nbreak'
      let s = '';
      for (i += 2; i < text.length && text[i] !== "'"; i++) {
        if (text[i] !== '\\') {
          s += text[i];
          continue;
        }
        const n = text[++i];
        const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', e: '\x1b', a: '\x07', b: '\b', f: '\f', v: '\v' };
        if (n in map) s += map[n];
        else if (n === 'x') {
          s += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else if (n === 'u') {
          s += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
          i += 4;
        } else s += '\\' + n;
      }
      if (i >= text.length) throw new Error("Unclosed $'…' quote");
      push(s);
    } else if (c === '"') {
      let s = '';
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (!cmd && text[i] === '\\' && '"\\$`\n'.includes(text[i + 1])) s += text[++i];
        else if (cmd && text[i] === '\\' && text[i + 1] === '"') s += text[++i];
        else s += text[i];
      }
      if (i >= text.length) throw new Error('Unclosed double quote');
      push(s);
    } else if (c === '\\' && !cmd) {
      push(text[++i] ?? '');
    } else {
      push(c);
    }
  }
  if (w !== null) words.push(w);
  return words;
}

/** -sSL → -s -S -L; -XPOST → -X POST; -H'Accept: x' → -H 'Accept: x' */
function expandShort(args) {
  const out = [];
  for (const a of args) {
    if (!/^-[a-zA-Z#]{2,}/.test(a) || a.startsWith('--')) {
      out.push(a);
      continue;
    }
    const chars = a.slice(1);
    for (let j = 0; j < chars.length; j++) {
      out.push('-' + chars[j]);
      if (SHORT_WITH_VALUE.has(chars[j])) {
        if (j + 1 < chars.length) out.push(chars.slice(j + 1));
        break;
      }
    }
  }
  return out;
}

const kv = (key, value, extra = {}) => ({ key, value, file: '', disabled: false, ...extra });
const decode = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};
const splitPairs = (s) =>
  s
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [decode(p), ''] : [decode(p.slice(0, i)), decode(p.slice(i + 1))];
    });
// headers browsers add that are rarely wanted in a saved request: imported, but disabled
const BROWSER_NOISE = /^(sec-ch-|sec-fetch-|sec-gpc$|priority$|upgrade-insecure-requests$|dnt$|pragma$|cache-control$)/i;

export function parseCurl(text) {
  const words = shellWords(text);
  if (!/^curl(\.exe)?$/i.test(words[0] || '')) throw new Error('Not a cURL command');
  const warnings = [];
  const headers = [];
  const data = [];
  const form = [];
  let method = '';
  let url = '';
  let get = false;
  let json = false;
  let auth = null;
  let upload = ''; // --data-binary @file / -T file: sent as the raw file

  const args = expandShort(words.slice(1));
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let val;
    if (a.startsWith('--') && a.includes('=') && WITH_VALUE.has(a.slice(0, a.indexOf('=')))) {
      val = a.slice(a.indexOf('=') + 1);
      a = a.slice(0, a.indexOf('='));
    }
    if (WITH_VALUE.has(a) && val === undefined) {
      if (i + 1 >= args.length) throw new Error(`Option ${a} needs a value`);
      val = args[++i];
    }

    switch (a) {
      case '-X':
      case '--request':
        method = val.toUpperCase();
        break;
      case '-H':
      case '--header': {
        const c = val.indexOf(':');
        if (c > 0) headers.push(kv(val.slice(0, c).trim(), val.slice(c + 1).trim()));
        else if (val.endsWith(';')) headers.push(kv(val.slice(0, -1).trim(), ''));
        break;
      }
      case '-d':
      case '--data':
      case '--data-ascii':
      case '--data-binary':
      case '--data-raw':
        if (a !== '--data-raw' && val.startsWith('@')) {
          upload = val.slice(1);
          warnings.push(`Body file ${upload} must exist in the collection (path relative to the collection folder)`);
          break;
        }
        data.push(a === '-d' || a === '--data' || a === '--data-ascii' ? val.replace(/[\r\n]/g, '') : val);
        break;
      case '--data-urlencode': {
        const e = val.indexOf('=');
        data.push(e < 0 ? encodeURIComponent(val) : `${val.slice(0, e)}=${encodeURIComponent(val.slice(e + 1))}`);
        break;
      }
      case '--json':
        data.push(val);
        json = true;
        break;
      case '-F':
      case '--form':
      case '--form-string': {
        const e = val.indexOf('=');
        const key = e < 0 ? val : val.slice(0, e);
        let value = e < 0 ? '' : val.slice(e + 1);
        if (a !== '--form-string' && value.startsWith('@')) {
          const file = value.slice(1).split(';')[0];
          form.push(kv(key, '', { file }));
          warnings.push(`Form field ${key}: file ${file} must exist in the collection`);
        } else {
          if (a !== '--form-string' && value.startsWith('<')) warnings.push(`Form field ${key}: content from file ${value.slice(1)} is not imported`);
          form.push(kv(key, value));
        }
        break;
      }
      case '-u':
      case '--user': {
        const c = val.indexOf(':');
        auth = { type: 'basic', username: c < 0 ? val : val.slice(0, c), password: c < 0 ? '' : val.slice(c + 1) };
        break;
      }
      case '--oauth2-bearer':
        auth = { type: 'bearer', token: val };
        break;
      case '-b':
      case '--cookie':
        if (val.includes('=')) headers.push(kv('Cookie', val));
        else warnings.push(`Cookies from file ${val} are not imported`);
        break;
      case '-A':
      case '--user-agent':
        headers.push(kv('User-Agent', val));
        break;
      case '-e':
      case '--referer':
        headers.push(kv('Referer', val));
        break;
      case '--url':
        url = val;
        break;
      case '-G':
      case '--get':
        get = true;
        break;
      case '-I':
      case '--head':
        method = 'HEAD';
        break;
      case '-k':
      case '--insecure':
        warnings.push('-k (insecure) is not taken over: TLS verification is a collection setting');
        break;
      case '-x':
      case '--proxy':
        warnings.push(`Proxy ${val} is not taken over`);
        break;
      case '-T':
      case '--upload-file':
        upload = val;
        warnings.push(`Body file ${upload} must exist in the collection (path relative to the collection folder)`);
        method ||= 'PUT';
        break;
      default:
        if (a.startsWith('-') && a.length > 1) {
          if (!IGNORED.has(a)) warnings.push(`Ignored option ${a}`);
        } else if (!url) url = a;
        else warnings.push(`Ignored extra argument ${a}`);
    }
  }
  if (!url) throw new Error('No URL found in the cURL command');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('{{')) url = 'http://' + url;

  // query string → params
  const params = [];
  const q = url.indexOf('?');
  if (q >= 0) {
    const hash = url.indexOf('#', q);
    for (const [k, v] of splitPairs(url.slice(q + 1, hash < 0 ? undefined : hash))) params.push(kv(k, v));
    url = url.slice(0, q);
  }
  if (get && data.length) {
    for (const [k, v] of splitPairs(data.join('&'))) params.push(kv(k, v));
    data.length = 0;
  }

  const header = (name) => headers.find((h) => h.key.toLowerCase() === name);
  const drop = (name) => {
    const i = headers.findIndex((h) => h.key.toLowerCase() === name);
    if (i >= 0) headers.splice(i, 1);
  };

  // Authorization header → auth (inherits nicely, secrets are found the same way)
  const authz = header('authorization');
  if (authz && !auth) {
    const m = authz.value.match(/^(Bearer|Basic)\s+(\S+)$/i);
    if (m && m[1].toLowerCase() === 'bearer') {
      auth = { type: 'bearer', token: m[2] };
      drop('authorization');
    } else if (m) {
      try {
        const plain = new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)));
        const c = plain.indexOf(':');
        if (c >= 0) {
          auth = { type: 'basic', username: plain.slice(0, c), password: plain.slice(c + 1) };
          drop('authorization');
        }
      } catch {
        // not base64: keep the header as it is
      }
    }
  }

  // body
  let body = { type: 'none', content: '', fields: [] };
  const ct = (header('content-type')?.value || (json ? 'application/json' : '')).toLowerCase();
  if (upload && !data.length && !form.length) {
    body = { type: 'file', content: '', fields: [], file: upload };
    if (/^application\/octet-stream$/i.test(ct)) drop('content-type');
  } else if (form.length) {
    body = { type: 'multipart', content: '', fields: form };
    drop('content-type'); // the boundary is generated when sending
  } else if (data.length) {
    const raw = data.join('&');
    const looksJson = /^\s*[[{]/.test(raw);
    if (ct.includes('json') || (!ct && looksJson)) {
      let content = raw;
      try {
        content = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // keep as typed (may contain {{variables}})
      }
      body = { type: 'json', content, fields: [] };
      if (/^application\/json\s*(;\s*charset=utf-8)?$/i.test(ct)) drop('content-type');
    } else if (ct.includes('x-www-form-urlencoded') || (!ct && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(raw))) {
      body = { type: 'form', content: '', fields: splitPairs(raw).map(([k, v]) => kv(k, v)) };
      drop('content-type');
    } else if (ct.includes('xml')) {
      body = { type: 'xml', content: raw, fields: [] };
    } else {
      body = { type: 'text', content: raw, fields: [] };
    }
  }
  // headers curl/browsers manage themselves
  drop('content-length');
  const host = header('host');
  if (host && url.toLowerCase().includes(`//${host.value.toLowerCase()}`)) drop('host');
  let noisy = 0;
  for (const h of headers) {
    if (BROWSER_NOISE.test(h.key)) {
      h.disabled = true;
      noisy++;
    }
  }
  if (noisy) warnings.push(`${noisy} browser header${noisy > 1 ? 's were' : ' was'} imported disabled (sec-*, priority, …)`);

  method ||= data.length || form.length || upload ? 'POST' : 'GET';
  return {
    doc: { method, url, params, headers, auth: auth || { type: 'inherit' }, body },
    warnings,
  };
}
