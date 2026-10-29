import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBru, parseBruEnv, assertion } from './bruno.js';
import { importCollection } from './index.js';
import { buildCollectionFiles } from './build.js';
import { parseRequest, parseCollection, parseFolder, parseEnv } from '../format.js';

const folder = {
  'shop/bruno.json': JSON.stringify({ version: '1', name: 'Shop API', type: 'collection', ignore: ['node_modules', '.git'] }),
  'shop/collection.bru': `headers {
  Accept: application/json
}

auth {
  mode: bearer
}

auth:bearer {
  token: {{token}}
}

vars:pre-request {
  apiVersion: v2
}

docs {
  # Shop
  All endpoints.
}
`,
  'shop/.env': 'SHOP_SECRET=s3cr3t\n',
  'shop/environments/Local.bru': `vars {
  baseUrl: http://localhost:3000
  ~unused: x
}
vars:secret [
  token
]
`,
  'shop/Users/folder.bru': `meta {
  name: User management
  seq: 2
}

auth {
  mode: apikey
}

auth:apikey {
  key: X-Api-Key
  value: {{process.env.SHOP_SECRET}}
  placement: header
}
`,
  'shop/Users/Get user.bru': `meta {
  name: Get user
  type: http
  seq: 1
}

get {
  url: {{baseUrl}}/users/:id?expand=orders
  body: none
  auth: inherit
}

params:query {
  expand: orders
  ~trace: 1
}

params:path {
  id: 42
}

headers {
  ~X-Debug: 1
}

vars:post-response {
  userId: res.body.id
}

assert {
  res.status: eq 200
  res.body.name: isString
  ~res.body.x: eq 1
}

script:pre-request {
  bru.setVar("ts", Date.now());
}

tests {
  test("ok", function () {
    expect(res.getStatus()).to.equal(200);
  });
}

docs {
  Returns one user.
}
`,
  'shop/Users/Create user.bru': `meta {
  name: Create user
  type: http
  seq: 2
}

post {
  url: {{baseUrl}}/users
  body: json
  auth: none
}

body:json {
  {
    "name": "Kai",
    "tags": ["a"]
  }
}

vars:pre-request {
  stamp: {{apiVersion}}-x
}
`,
  'shop/Login.bru': `meta {
  name: Login
  seq: 1
}

post {
  url: {{baseUrl}}/login
  body: formUrlEncoded
  auth: basic
}

auth:basic {
  username: kai
  password: hunter2
}

body:form-urlencoded {
  grant_type: password
  ~scope: all
}
`,
  'shop/Upload.bru': `meta {
  name: Upload
  seq: 3
}

post {
  url: {{baseUrl}}/upload
  body: multipartForm
  auth: inherit
}

body:multipart-form {
  title: Hello @contentType(text/plain)
  file: @file(files/a.png)
}
`,
  'shop/Search.bru': `meta {
  name: Search
  type: graphql
  seq: 4
}

post {
  url: {{baseUrl}}/graphql
  body: graphql
  auth: inherit
}

body:graphql {
  query Find($q: String) {
    search(q: $q) { id }
  }
}

body:graphql:vars {
  {"q": "kai"}
}
`,
};
const inputs = Object.entries(folder).map(([name, text]) => ({ name, text }));

test('parseBru reads blocks, disabled entries and text bodies', () => {
  const it = parseBru(folder['shop/Users/Get user.bru']);
  assert.equal(it.name, 'Get user');
  assert.equal(it.request.method, 'GET');
  assert.deepEqual(it.request.params.find((p) => p.name === 'trace'), { name: 'trace', value: '1', enabled: false, type: 'query' });
  assert.equal(it.request.auth.mode, 'inherit');
  assert.equal(it.request.docs, 'Returns one user.');
  const json = parseBru(folder['shop/Users/Create user.bru']).request.body;
  assert.equal(json.mode, 'json');
  assert.deepEqual(JSON.parse(json.json), { name: 'Kai', tags: ['a'] });
});

test('multi-line values and environments', () => {
  const it = parseBru(`post {\n  url: http://x\n}\n\nheaders {\n  X-Long: '''\n    line 1\n    line 2\n  '''\n}\n`);
  assert.equal(it.request.headers[0].value, 'line 1\nline 2');
  const env = parseBruEnv(folder['shop/environments/Local.bru'], 'Local');
  assert.deepEqual(env.variables, [
    { name: 'baseUrl', value: 'http://localhost:3000', enabled: true },
    { name: 'unused', value: 'x', enabled: false },
    { name: 'token', value: '', enabled: true, secret: true },
  ]);
});

test('a Bruno folder becomes a collection', () => {
  const r = importCollection(inputs);
  assert.equal(r.format, 'Bruno collection (folder, zip or JSON export)');
  assert.equal(r.name, 'Shop API');
  assert.deepEqual(r.collection.auth, { type: 'bearer', token: '{{token}}' });
  assert.deepEqual(r.collection.variables.map((v) => [v.key, v.value]), [['apiVersion', 'v2']]);
  assert.equal(r.collection.headers[0].key, 'Accept');
  assert.match(r.docs, /All endpoints/);

  // Bruno's seq order; the folder (seq 2) sits between Login and Upload
  assert.deepEqual(r.requests.map((q) => `${q.dir} ${q.doc.name}`), [
    'requests Login',
    'requests/user-management Get user',
    'requests/user-management Create user',
    'requests Upload',
    'requests Search',
  ]);
  const req = (name) => r.requests.find((q) => q.doc.name === name).doc;
  const folderDoc = r.folders[0].doc;
  assert.equal(folderDoc.name, 'User management');
  assert.deepEqual(folderDoc.auth, { type: 'apikey', key: 'X-Api-Key', value: '{{SHOP_SECRET}}', in: 'header' });

  const get = req('Get user');
  assert.equal(get.url, '{{baseUrl}}/users/{{id}}');
  assert.deepEqual(get.variables.map((v) => [v.key, v.value]), [['id', '42']]);
  assert.deepEqual(get.params.map((p) => [p.key, p.disabled]), [
    ['expand', false],
    ['trace', true],
  ]);
  assert.match(get.scripts.post, /vars\.set\("userId", \(\(res\) => \(res\.body\.id\)\)\(bruRes\)\);/);
  assert.match(get.scripts.post, /test\("res\.status eq 200", \(\) => \{ const res = bruRes; expect\(\(res\.status\)\)\.toEqual\(200\); \}\);/);
  assert.doesNotMatch(get.scripts.post, /res\.body\.x/);
  assert.match(get.scripts.post, /\/\/ Bruno tests/);
  assert.match(get.scripts.pre, /^\/\/ Bruno pre-request script/);

  const create = req('Create user');
  assert.deepEqual(create.auth, { type: 'none' });
  // vars:pre-request are request variables, no script detour
  assert.deepEqual(create.variables.map((v) => [v.key, v.value]), [['stamp', '{{apiVersion}}-x']]);
  assert.equal(create.scripts.pre, '');

  const login = req('Login');
  assert.deepEqual(login.auth, { type: 'basic', username: 'kai', password: 'hunter2' });
  assert.deepEqual(login.body.fields.map((f) => [f.key, f.value, f.disabled]), [
    ['grant_type', 'password', false],
    ['scope', 'all', true],
  ]);
  const upload = req('Upload').body;
  assert.equal(upload.type, 'multipart');
  assert.deepEqual(upload.fields.map((f) => [f.key, f.value, f.file]), [
    ['title', 'Hello', ''],
    ['file', '', 'files/a.png'],
  ]);
  const gql = req('Search').body;
  assert.equal(gql.type, 'graphql');
  assert.match(gql.content, /^query Find/);
  assert.deepEqual(JSON.parse(gql.variables), { q: 'kai' });

  // environments: Bruno secrets empty and private, process.env from .env
  assert.deepEqual(r.environments, [
    {
      name: 'Local',
      values: [
        { key: 'baseUrl', value: 'http://localhost:3000', secret: false },
        { key: 'token', value: '', secret: true },
        { key: 'SHOP_SECRET', value: 's3cr3t', secret: true },
      ],
    },
  ]);
  assert.ok(r.warnings.some((w) => /process\.env/.test(w)));
  assert.ok(r.warnings.some((w) => /form file “file”/.test(w)));
});

test('the files of a Bruno import parse back', () => {
  const r = importCollection(inputs);
  const { files } = buildCollectionFiles(r, { secretsEnv: 'Local' });
  assert.equal(parseCollection(files['postbote.yaml']).doc.name, 'Shop API');
  assert.equal(parseFolder(files['requests/user-management/_folder.yaml']).doc.auth.type, 'apikey');
  const login = parseRequest(files['requests/login.req.yaml']).doc;
  assert.equal(login.auth.password, '{{password}}');
  assert.deepEqual(parseEnv(files['environments/local.env']).map((e) => e.key), ['token', 'SHOP_SECRET', 'password']);
  assert.ok(!files['environments/local.env.pub'].includes('s3cr3t'));
});

test('without bruno.json the common folder is the root; single files work too', () => {
  const r = importCollection([{ name: 'Login.bru', text: folder['shop/Login.bru'] }]);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].dir, 'requests');
  const r2 = importCollection(inputs.filter((i) => !i.name.endsWith('bruno.json')));
  assert.equal(r2.name, 'shop');
  assert.equal(r2.requests.length, 5);
});

test('Bruno JSON export', () => {
  const exp = {
    name: 'Exported',
    version: '1',
    items: [
      {
        type: 'folder',
        name: 'Orders',
        root: { request: { auth: { mode: 'bearer', bearer: { token: '{{orderToken}}' } } }, meta: { seq: 1 } },
        items: [
          {
            type: 'http-request',
            name: 'List orders',
            seq: 1,
            request: {
              method: 'GET',
              url: '{{baseUrl}}/orders?status=open',
              params: [{ name: 'status', value: 'open', type: 'query', enabled: true }],
              headers: [{ name: 'X-Trace', value: '1', enabled: false }],
              auth: { mode: 'inherit' },
              body: { mode: 'none' },
              assertions: [{ name: 'res.body.length', value: 'gt 0', enabled: true }],
              script: {},
              vars: {},
            },
          },
        ],
      },
      { type: 'grpc-request', name: 'Stream', request: {} },
    ],
    environments: [{ name: 'prod', variables: [{ name: 'baseUrl', value: 'https://shop.example', enabled: true, secret: false }] }],
    root: { request: { headers: [{ name: 'Accept', value: 'application/json', enabled: true }] }, docs: 'Exported docs' },
    brunoConfig: { version: '1', name: 'Exported', type: 'collection' },
  };
  const r = importCollection([{ name: 'Exported.json', text: JSON.stringify(exp) }]);
  assert.equal(r.name, 'Exported');
  assert.equal(r.docs, 'Exported docs');
  assert.equal(r.folders[0].doc.auth.token, '{{orderToken}}');
  const q = r.requests[0].doc;
  assert.equal(q.url, '{{baseUrl}}/orders');
  assert.deepEqual(q.params.map((p) => [p.key, p.value]), [['status', 'open']]);
  assert.equal(q.headers[0].disabled, true);
  assert.match(q.scripts.post, /toBeGreaterThan\(0\)/);
  assert.equal(r.environments[0].values[0].value, 'https://shop.example');
  assert.ok(r.warnings.some((w) => /grpc-request requests are not supported/.test(w)));
});

test('assertion operators', () => {
  const t = (value, name = 'res.status') => assertion({ name, value });
  assert.match(t('neq 404'), /not\.toEqual\(404\)/);
  assert.match(t('in 200, 201'), /expect\(\[200, 201\]\)\.toContain\(\(res\.status\)\)/);
  assert.match(t('contains "ok"', 'res.body.msg'), /toContain\("ok"\)/);
  assert.match(t('eq kai', 'res.body.name'), /toEqual\("kai"\)/);
  assert.match(t('matches ^a.+z$', 'res.body.name'), /new RegExp\("\^a\.\+z\$"\)/);
  assert.match(t('between 1, 5'), /const \[lo, hi\] = \[1, 5\]/);
  assert.match(t('isEmpty', 'res.body.items'), /isEmpty\(\(res\.body\.items\)\)\)\.toBe\(true\)/);
  assert.match(t('frobnicates 1'), /^\/\/ Bruno assertion not converted/);
});
