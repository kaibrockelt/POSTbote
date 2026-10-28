import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCollection, importRequest } from './index.js';
import { buildCollectionFiles } from './build.js';
import { parseEnv, parseRequest } from '../format.js';

const httpFile = `@baseUrl = https://api.example.test
@version = v2

### List users
# Returns all users
GET {{baseUrl}}/{{version}}/users
    ?page=2
    &q=ada
Accept: application/json
Authorization: Bearer {{token}}

> {%
  client.test("ok", () => client.assert(response.status === 200));
%}

###
# @name createUser
POST {{baseUrl}}/users HTTP/1.1
Content-Type: application/json
X-Request-Id: {{$random.uuid}}

{
  "name": "Ada"
}

### Upload avatar
PUT {{baseUrl}}/users/1/avatar
Content-Type: image/png

< ./data/avatar.png

### Login form
POST {{baseUrl}}/login
Content-Type: application/x-www-form-urlencoded

user=ada
&pass={{password}}

### plain
https://api.example.test/health
`;

const env = JSON.stringify({ dev: { baseUrl: 'http://localhost:8080', token: '' }, prod: { baseUrl: 'https://api.example.test' } });
const priv = JSON.stringify({ dev: { token: 'dev-secret', password: 'pw' } });

test('.http file with JetBrains environments', () => {
  const r = importCollection([
    { name: 'users.http', text: httpFile },
    { name: 'http-client.env.json', text: env },
    { name: 'http-client.private.env.json', text: priv },
  ]);
  assert.equal(r.format, '.http / .rest files (JetBrains, VS Code)');
  assert.equal(r.name, 'users');
  assert.deepEqual(r.collection.variables.map((v) => [v.key, v.value]), [['baseUrl', 'https://api.example.test'], ['version', 'v2']]);
  const [list, create, upload, login, health] = r.requests.map((q) => q.doc);

  assert.equal(list.name, 'List users');
  assert.equal(list.url, '{{baseUrl}}/{{version}}/users');
  assert.deepEqual(list.params.map((p) => [p.key, p.value]), [['page', '2'], ['q', 'ada']]);
  assert.deepEqual(list.auth, { type: 'bearer', token: '{{token}}' });
  assert.match(list.scripts.post, /^\/\/ response handler/);

  assert.equal(create.name, 'createUser');
  assert.equal(create.method, 'POST');
  assert.equal(create.body.type, 'json');
  assert.deepEqual(create.headers.map((h) => [h.key, h.value]), [['X-Request-Id', '{{$uuid}}']]);

  assert.deepEqual([upload.method, upload.body.type, upload.body.file], ['PUT', 'file', 'data/avatar.png']);
  assert.deepEqual(login.body.fields.map((f) => [f.key, f.value]), [['user', 'ada'], ['pass', '{{password}}']]);
  assert.deepEqual([health.method, health.url, health.name], ['GET', 'https://api.example.test/health', 'plain']);

  assert.deepEqual(r.environments, [
    { name: 'dev', values: [{ key: 'baseUrl', value: 'http://localhost:8080', secret: false }, { key: 'token', value: 'dev-secret', secret: true }, { key: 'password', value: 'pw', secret: true }] },
    { name: 'prod', values: [{ key: 'baseUrl', value: 'https://api.example.test', secret: false }] },
  ]);
  const { files } = buildCollectionFiles(r);
  assert.deepEqual(parseEnv(files['environments/dev.env']), [{ key: 'token', value: 'dev-secret' }, { key: 'password', value: 'pw' }]);
  assert.equal(parseRequest(files['requests/createuser.req.yaml']).doc.method, 'POST');
});

test('several .http files become folders', () => {
  const r = importCollection([
    { name: 'a.http', text: 'GET https://x.test/a\n' },
    { name: 'b.rest', text: 'GET https://x.test/b\n' },
  ]);
  assert.deepEqual(r.folders.map((f) => f.path), ['requests/a', 'requests/b']);
  assert.deepEqual(r.requests.map((q) => q.dir), ['requests/a', 'requests/b']);
});

test('pasted raw HTTP request', () => {
  const { format, doc } = importRequest('POST https://x.test/items HTTP/1.1\nContent-Type: application/json\n\n{"a": 1}\n');
  assert.equal(format, 'raw HTTP request');
  assert.deepEqual([doc.method, doc.url, doc.body.type, doc.body.content], ['POST', 'https://x.test/items', 'json', '{"a": 1}']);
  assert.equal(importRequest('https://x.test/plain').doc.method, 'GET');
  // curl keeps priority for curl commands
  assert.equal(importRequest('curl https://x.test').format, 'cURL');
});

const harLog = {
  log: {
    version: '1.2',
    creator: { name: 'WebInspector', version: '537.36' },
    entries: [
      {
        startedDateTime: '2026-10-28T10:00:00Z',
        _resourceType: 'fetch',
        request: {
          method: 'POST',
          url: 'https://api.shop.test/v1/orders?draft=true&x=a%20b',
          headers: [
            { name: ':authority', value: 'api.shop.test' },
            { name: 'content-type', value: 'application/json' },
            { name: 'authorization', value: 'Bearer abc' },
            { name: 'cookie', value: 'sid=1' },
            { name: 'sec-fetch-mode', value: 'cors' },
            { name: 'x-client', value: 'web' },
          ],
          queryString: [{ name: 'draft', value: 'true' }, { name: 'x', value: 'a%20b' }],
          postData: { mimeType: 'application/json', text: '{"item":1}' },
        },
        response: { status: 201 },
      },
      { _resourceType: 'image', request: { method: 'GET', url: 'https://cdn.shop.test/logo.png', headers: [] } },
      { _resourceType: 'xhr', request: { method: 'GET', url: 'https://auth.shop.test/me', headers: [] }, response: { status: 200 } },
      { _resourceType: 'xhr', request: { method: 'GET', url: 'https://auth.shop.test/me', headers: [] }, response: { status: 200 } },
      {
        _resourceType: 'fetch',
        request: { method: 'POST', url: 'https://auth.shop.test/login', headers: [], postData: { mimeType: 'application/x-www-form-urlencoded', text: 'user=ada&pass=pw' } },
      },
    ],
  },
};

test('HAR: API calls per host, noise filtered', () => {
  const r = importCollection([{ name: 'session.har', text: JSON.stringify(harLog) }]);
  assert.equal(r.format, 'HAR (browser network log)');
  assert.deepEqual(r.folders.map((f) => [f.path, f.doc.name]), [['requests/api-shop-test', 'api.shop.test'], ['requests/auth-shop-test', 'auth.shop.test']]);
  assert.equal(r.requests.length, 3); // image skipped, repeated call deduplicated
  const order = r.requests[0].doc;
  assert.equal(order.url, 'https://api.shop.test/v1/orders');
  assert.deepEqual(order.params.map((p) => [p.key, p.value]), [['draft', 'true'], ['x', 'a b']]);
  assert.deepEqual(order.headers.map((h) => [h.key, h.disabled]), [['sec-fetch-mode', true], ['x-client', false]]);
  assert.deepEqual(order.auth, { type: 'bearer', token: 'abc' });
  assert.equal(JSON.parse(order.body.content).item, 1);
  assert.match(order.docs, /→ 201/);
  assert.deepEqual(r.requests[2].doc.body.fields.map((f) => [f.key, f.value]), [['user', 'ada'], ['pass', 'pw']]);
  const w = r.warnings.join('\n');
  assert.match(w, /1 static resource/);
  assert.match(w, /Cookie headers were not imported/);
});

test('chained request variables produce a hint', () => {
  const r = importCollection([{ name: 'c.http', text: '# @name login\nPOST https://x.test/login\n\n###\nGET https://x.test/me\nAuthorization: Bearer {{login.response.body.$.token}}\n' }]);
  assert.match(r.warnings.join('\n'), /\{\{login\.response\.body\.\$\.token\}\} are not resolved/);
});
