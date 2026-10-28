import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCurl, shellWords } from './curl.js';

const hv = (doc) => Object.fromEntries(doc.headers.map((h) => [h.key, h.disabled ? `(off) ${h.value}` : h.value]));

test('shell words: quotes, escapes, continuations', () => {
  assert.deepEqual(shellWords(`curl 'a b' "c \\"d\\"" e\\ f \\\n  $'x\\ny'`), ['curl', 'a b', 'c "d"', 'e f', 'x\ny']);
  assert.deepEqual(shellWords('curl ^"https://x.io/?a=1^&b=2^" ^\n  -H ^"Accept: */*^"'), ['curl', 'https://x.io/?a=1&b=2', '-H', 'Accept: */*']);
  assert.throws(() => shellWords("curl 'oops"), /Unclosed/);
});

test('simple GET with query and headers', () => {
  const { doc, warnings } = parseCurl(`curl -sSL 'https://api.example.com/users?page=2&q=a%20b' -H 'Accept: application/json'`);
  assert.equal(doc.method, 'GET');
  assert.equal(doc.url, 'https://api.example.com/users');
  assert.deepEqual(doc.params.map((p) => [p.key, p.value]), [['page', '2'], ['q', 'a b']]);
  assert.deepEqual(hv(doc), { Accept: 'application/json' });
  assert.deepEqual(warnings, []);
});

test('JSON POST with bearer token', () => {
  const { doc } = parseCurl(`curl -XPOST https://api.example.com/users \\
    -H 'Authorization: Bearer abc.def' \\
    -H 'Content-Type: application/json' \\
    --data-raw '{"name":"ada","tags":["x"]}'`);
  assert.equal(doc.method, 'POST');
  assert.deepEqual(doc.auth, { type: 'bearer', token: 'abc.def' });
  assert.equal(doc.body.type, 'json');
  assert.equal(doc.body.content, '{\n  "name": "ada",\n  "tags": [\n    "x"\n  ]\n}');
  assert.deepEqual(hv(doc), {}); // Authorization → auth, default content type dropped
});

test('--json, form data, -G, basic auth', () => {
  assert.equal(parseCurl(`curl --json '{"a":1}' x.io`).doc.body.type, 'json');
  assert.equal(parseCurl(`curl --json '{"a":1}' x.io`).doc.url, 'http://x.io');

  const form = parseCurl(`curl https://x.io/login -d 'user=ada' -d 'pass=s%26cret'`).doc;
  assert.equal(form.method, 'POST');
  assert.equal(form.body.type, 'form');
  assert.deepEqual(form.body.fields.map((f) => [f.key, f.value]), [['user', 'ada'], ['pass', 's&cret']]);

  const g = parseCurl(`curl -G https://x.io/search --data-urlencode 'q=a b' -d n=5`).doc;
  assert.equal(g.method, 'GET');
  assert.deepEqual(g.params.map((p) => [p.key, p.value]), [['q', 'a b'], ['n', '5']]);
  assert.equal(g.body.type, 'none');

  assert.deepEqual(parseCurl(`curl -u ada:pw https://x.io`).doc.auth, { type: 'basic', username: 'ada', password: 'pw' });
  // Basic header is decoded into basic auth
  assert.deepEqual(parseCurl(`curl -H 'Authorization: Basic YWRhOnB3' https://x.io`).doc.auth, { type: 'basic', username: 'ada', password: 'pw' });
});

test('multipart with file, method override, warnings', () => {
  const { doc, warnings } = parseCurl(`curl -k -X PUT https://x.io/up -F 'name=ada' -F 'avatar=@me.png;type=image/png' -H 'Content-Type: multipart/form-data; boundary=x'`);
  assert.equal(doc.method, 'PUT');
  assert.equal(doc.body.type, 'multipart');
  assert.deepEqual(doc.body.fields.map((f) => [f.key, f.value, f.file]), [['name', 'ada', ''], ['avatar', '', 'me.png']]);
  assert.deepEqual(hv(doc), {});
  assert.ok(warnings.some((w) => w.includes('insecure')));
  assert.ok(warnings.some((w) => w.includes('me.png')));
});

test('Chrome "Copy as cURL (bash)"', () => {
  const text = `curl 'https://api.example.com/v1/items' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'content-type: application/json' \\
  -H 'cookie: sid=123' \\
  -H 'priority: u=1, i' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-fetch-mode: cors' \\
  --data-raw $'{"note":"it\\'s ok"}'`;
  const { doc, warnings } = parseCurl(text);
  assert.equal(doc.method, 'POST');
  assert.equal(JSON.parse(doc.body.content).note, "it's ok");
  assert.equal(hv(doc).cookie, 'sid=123');
  assert.equal(hv(doc)['sec-fetch-mode'], '(off) cors');
  assert.ok(warnings[0].includes('3 browser headers'));
});

test('Chrome "Copy as cURL (cmd)"', () => {
  const text = 'curl ^"https://api.example.com/v1/items?x=1^&y=2^" ^\n  -H ^"accept: application/json^" ^\n  --data-raw ^"^{^\\^"a^\\^":1^}^"';
  const { doc } = parseCurl(text);
  assert.equal(doc.url, 'https://api.example.com/v1/items');
  assert.equal(doc.params.length, 2);
  assert.equal(doc.body.type, 'json');
  assert.equal(JSON.parse(doc.body.content).a, 1);
});

test('errors', () => {
  assert.throws(() => parseCurl('curl -H "Accept: x"'), /No URL/);
  assert.throws(() => parseCurl('curl https://x.io -X'), /needs a value/);
});

test('binary uploads become file bodies', () => {
  const a = parseCurl(`curl -X POST https://x.io/up --data-binary @data/photo.png -H 'Content-Type: image/png'`).doc;
  assert.deepEqual([a.method, a.body.type, a.body.file], ['POST', 'file', 'data/photo.png']);
  assert.equal(hv(a)['Content-Type'], 'image/png');
  const t = parseCurl(`curl -T backup.zip https://x.io/files/backup.zip`).doc;
  assert.deepEqual([t.method, t.body.type, t.body.file], ['PUT', 'file', 'backup.zip']);
});
