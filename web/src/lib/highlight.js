// Minimal JSON highlighting. Input is HTML-escaped before tokens are wrapped,
// so the result is safe for {@html}.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightJson(text) {
  return esc(text).replace(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, _s, colon) => {
      let cls = 'num';
      if (m.startsWith('"')) cls = colon ? 'key' : 'str';
      else if (m === 'true' || m === 'false') cls = 'bool';
      else if (m === 'null') cls = 'null';
      return `<span class="j-${cls}">${m}</span>`;
    },
  );
}

export function prettyBody(body, contentType = '') {
  const ct = contentType.toLowerCase();
  const t = body.trimStart();
  if (ct.includes('json') || t.startsWith('{') || t.startsWith('[')) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), json: true };
    } catch {
      /* not json */
    }
  }
  return { text: body, json: false };
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function statusKind(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'warn';
  return 'bad';
}
