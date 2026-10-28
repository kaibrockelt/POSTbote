import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePostman } from './postman.js';
import { importCollection } from './index.js';
import { buildCollectionFiles } from './build.js';
import { parseRequest, parseCollection, parseFolder, parseEnv } from '../format.js';

const collection = {
  info: { name: 'Shop API', description: 'All shop endpoints.', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [
    { key: 'baseUrl', value: 'https://shop.test/v1' },
    { key: 'apiSecret', value: 'oops' },
  ],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  event: [{ listen: 'prerequest', script: { exec: ["pm.environment.set('ts', Date.now());"] } }],
  item: [
    {
      name: 'Users',
      description: 'User management.',
      auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key' }, { key: 'value', value: 'k-123' }, { key: 'in', value: 'header' }] },
      item: [
        {
          name: 'Get user',
          request: {
            method: 'GET',
            header: [
              { key: 'Accept', value: 'application/json' },
              { key: 'X-Debug', value: '1', disabled: true },
            ],
            url: {
              raw: '{{baseUrl}}/users/:id?expand=orders&trace',
              host: ['{{baseUrl}}'],
              path: ['users', ':id'],
              query: [
                { key: 'expand', value: 'orders' },
                { key: 'trace', value: null, disabled: true },
              ],
              variable: [{ key: 'id', value: '42' }],
            },
            description: 'Returns one user.',
          },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }],
          response: [{ name: 'Example' }],
        },
        {
          name: 'Create user',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"name":"{{$randomFirstName}}","id":"{{$guid}}"}', options: { raw: { language: 'json' } } },
            url: '{{baseUrl}}/users',
            auth: { type: 'noauth' },
          },
        },
      ],
    },
    {
      name: 'Upload',
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'multipart/form-data; boundary=x' }],
        body: { mode: 'formdata', formdata: [{ key: 'title', value: 'Hi', type: 'text' }, { key: 'file', type: 'file', src: '/Users/me/pic.png' }] },
        url: '{{baseUrl}}/upload',
      },
    },
    {
      name: 'Login',
      request: {
        method: 'POST',
        body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'ada' }, { key: 'pass', value: 'pw', disabled: true }] },
        url: '{{baseUrl}}/login',
      },
    },
    {
      name: 'Search',
      request: { method: 'POST', body: { mode: 'graphql', graphql: { query: '{ users { id } }', variables: '{"n":1}' } }, url: '{{baseUrl}}/graphql' },
    },
  ],
};

const environment = {
  name: 'Staging',
  _postman_variable_scope: 'environment',
  values: [
    { key: 'baseUrl', value: 'https://staging.shop.test/v1', enabled: true },
    { key: 'token', value: 'tok-1', type: 'secret', enabled: true },
    { key: 'unused', value: 'x', enabled: false },
  ],
};

const inputs = () => [
  { name: 'shop.postman_collection.json', json: structuredClone(collection) },
  { name: 'staging.postman_environment.json', json: structuredClone(environment) },
];

test('structure, folders and order', () => {
  const r = parsePostman(inputs());
  assert.equal(r.name, 'Shop API');
  assert.equal(r.docs, 'All shop endpoints.');
  assert.deepEqual(r.folders.map((f) => f.path), ['requests/users']);
  assert.deepEqual(r.requests.map((q) => [q.dir, q.doc.name]), [
    ['requests/users', 'Get user'],
    ['requests/users', 'Create user'],
    ['requests', 'Upload'],
    ['requests', 'Login'],
    ['requests', 'Search'],
  ]);
  assert.deepEqual(r.collection.auth, { type: 'bearer', token: '{{token}}' });
  assert.deepEqual(r.folders[0].doc.auth, { type: 'apikey', key: 'X-Api-Key', value: 'k-123', in: 'header' });
});

test('requests: url, path variables, params, headers, auth, body', () => {
  const r = parsePostman(inputs());
  const [get, create, upload, login, search] = r.requests.map((q) => q.doc);
  assert.equal(get.url, '{{baseUrl}}/users/{{id}}');
  assert.deepEqual(get.params.map((p) => [p.key, p.value, p.disabled]), [['expand', 'orders', false], ['trace', '', true]]);
  assert.deepEqual(get.headers.map((h) => [h.key, h.disabled]), [['Accept', false], ['X-Debug', true]]);
  assert.equal(get.auth.type, 'inherit');
  assert.equal(get.docs, 'Returns one user.');
  assert.match(get.scripts.post, /^\/\/ Postman test script/);
  assert.ok(r.collection.variables.some((v) => v.key === 'id' && v.value === '42'));

  assert.equal(create.auth.type, 'none');
  assert.equal(create.body.type, 'json');

  assert.equal(upload.body.type, 'multipart');
  assert.deepEqual(upload.body.fields.map((f) => [f.key, f.value, f.file]), [['title', 'Hi', ''], ['file', '', 'pic.png']]);
  assert.equal(upload.headers.length, 0); // boundary header removed

  assert.equal(login.body.type, 'form');
  assert.deepEqual(login.body.fields.map((f) => f.disabled), [false, true]);

  assert.deepEqual([search.body.type, search.body.content, JSON.parse(search.body.variables)], ['graphql', '{ users { id } }', { n: 1 }]);
});

test('environments and warnings', () => {
  const r = parsePostman(inputs());
  assert.deepEqual(r.environments, [
    {
      name: 'Staging',
      values: [
        { key: 'baseUrl', value: 'https://staging.shop.test/v1', secret: false },
        { key: 'token', value: 'tok-1', secret: true },
      ],
    },
  ]);
  const w = r.warnings.join('\n');
  assert.match(w, /apiSecret.*looks like a secret/);
  assert.match(w, /\{\{\$randomFirstName\}\}/);
  assert.doesNotMatch(w, /\$guid/); // built in
  assert.match(w, /2 Postman scripts were imported as comments/);
  assert.match(w, /1 saved example response was not imported/);
  assert.match(w, /form file “file”/);
  assert.doesNotMatch(w, /GraphQL/);
});

test('v2.0 auth objects, v1 and missing collection', () => {
  const v20 = { info: { name: 'Old' }, item: [{ name: 'A', request: { url: 'https://x.test', auth: { type: 'basic', basic: { username: 'u', password: 'p' } } } }] };
  assert.deepEqual(parsePostman([{ name: 'a.json', json: v20 }]).requests[0].doc.auth, { type: 'basic', username: 'u', password: 'p' });
  assert.throws(() => parsePostman([{ name: 'v1.json', json: { id: 'x', name: 'v1', order: [], requests: [] } }]), /v1 is not supported/);
  assert.throws(() => parsePostman([{ name: 'env.json', json: environment }]), /No Postman collection/);
});

test('end to end through importCollection and the builder', () => {
  const res = importCollection(inputs().map((i) => ({ name: i.name, text: JSON.stringify(i.json) })));
  assert.equal(res.format, 'Postman collection (v2.0/v2.1) + environments');
  const { files } = buildCollectionFiles(res, { secretsEnv: 'Staging' });
  assert.equal(parseCollection(files['postbote.yaml']).doc.auth.token, '{{token}}');
  assert.equal(parseFolder(files['requests/users/_folder.yaml']).doc.auth.value, '{{apiKey}}');
  assert.equal(parseRequest(files['requests/users/get-user.req.yaml']).doc.url, '{{baseUrl}}/users/{{id}}');
  assert.deepEqual(parseEnv(files['environments/staging.env']), [
    { key: 'token', value: 'tok-1' },
    { key: 'apiKey', value: 'k-123' },
  ]);
  assert.equal(parseEnv(files['environments/staging.env.pub']).find((v) => v.key === 'token').value, '');
});
