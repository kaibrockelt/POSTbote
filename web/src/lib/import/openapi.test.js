import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCollection } from './index.js';
import { buildCollectionFiles } from './build.js';
import { parseRequest, parseCollection, parseEnv } from '../format.js';

const v31 = `
openapi: 3.1.0
info: { title: Shop API, version: 2.1.0, description: The shop. }
servers:
  - url: https://{region}.shop.test/v2/
    description: Production
    variables: { region: { default: eu, enum: [eu, us] } }
  - url: https://staging.shop.test/v2
    description: Staging
tags:
  - { name: Users, description: User management }
  - { name: Admins, parent: Users }
  - { name: Orders }
security: [{ bearerAuth: [] }]
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
    key: { type: apiKey, in: header, name: X-Api-Key }
  parameters:
    UserId: { name: userId, in: path, required: true, schema: { type: integer, example: 42 } }
  schemas:
    User:
      type: object
      required: [name]
      properties:
        id: { type: integer, readOnly: true }
        name: { type: string, example: Ada }
        email: { type: string, format: email }
        tags: { type: array, items: { type: string } }
        manager: { $ref: '#/components/schemas/User' }
        role: { type: [string, 'null'], enum: [admin, user] }
    NewUser:
      allOf:
        - $ref: '#/components/schemas/User'
        - type: object
          properties: { password: { type: string, format: password } }
paths:
  /users:
    get:
      tags: [Users]
      summary: List users
      operationId: listUsers
      parameters:
        - { name: limit, in: query, schema: { type: integer, default: 20 } }
        - { name: q, in: query, required: true, schema: { type: string }, example: ada }
        - { name: X-Trace, in: header, schema: { type: string } }
        - { name: Accept, in: header, schema: { type: string } }
        - { name: session, in: cookie, schema: { type: string } }
    post:
      tags: [Users]
      summary: Create user
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/NewUser' }
  /users/{userId}:
    parameters: [{ $ref: '#/components/parameters/UserId' }]
    get:
      tags: [Users]
      operationId: getUser
      deprecated: true
      description: One user.
    put:
      tags: [Admins]
      summary: Replace user
      security: [{ key: [] }]
      requestBody:
        content:
          application/json:
            examples:
              ada: { value: { name: Ada Lovelace } }
  /orders:
    post:
      tags: [Orders]
      summary: Upload order
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                note: { type: string, example: urgent }
                file: { type: string, format: binary }
      callbacks:
        done: { '{$request.body#/url}': { post: { responses: { '200': { description: ok } } } } }
  /health:
    get:
      summary: Health
      security: []
  /login:
    post:
      summary: Login
      security: []
      requestBody:
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              properties: { user: { type: string }, pass: { type: string, example: pw } }
  /report:
    get:
      summary: Report
      requestBody:
        content:
          application/xml: { schema: { type: object } }
  /ext:
    get:
      summary: External
      parameters: [{ $ref: 'common.yaml#/components/parameters/Page' }]
webhooks:
  newUser: { post: { responses: { '200': { description: ok } } } }
`;

const swagger = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Petstore', version: '1' },
  host: 'petstore.test',
  basePath: '/v1',
  schemes: ['http', 'https'],
  securityDefinitions: { basic: { type: 'basic' } },
  security: [{ basic: [] }],
  definitions: { Pet: { type: 'object', properties: { name: { type: 'string', example: 'Rex' }, age: { type: 'integer' } } } },
  paths: {
    '/pets/{petId}': {
      post: {
        tags: ['pets'],
        operationId: 'updatePet',
        consumes: ['multipart/form-data'],
        parameters: [
          { name: 'petId', in: 'path', required: true, type: 'string', default: 'p1' },
          { name: 'name', in: 'formData', type: 'string', default: 'Rex' },
          { name: 'photo', in: 'formData', type: 'file' },
        ],
      },
      put: {
        tags: ['pets'],
        summary: 'Replace pet',
        parameters: [
          { name: 'petId', in: 'path', required: true, type: 'string' },
          { name: 'body', in: 'body', schema: { $ref: '#/definitions/Pet' } },
          { name: 'dry', in: 'query', type: 'boolean', default: false },
        ],
      },
    },
  },
});

const imp = (files) => importCollection(files.map(([name, text]) => ({ name, text })));

test('OpenAPI 3.1: structure, servers, security', () => {
  const r = imp([['shop.yaml', v31]]);
  assert.equal(r.format, 'OpenAPI 3.x / Swagger 2.0');
  assert.equal(r.name, 'Shop API');
  assert.match(r.docs, /The shop\.\n\nVersion 2\.1\.0/);
  assert.match(r.docs, /region = eu \(eu, us\)/);
  assert.deepEqual(r.folders.map((f) => [f.path, f.doc.name, f.docs]), [
    ['requests/users', 'Users', 'User management'],
    ['requests/users/admins', 'Admins', ''],
    ['requests/orders', 'Orders', ''],
  ]);
  assert.deepEqual(r.collection.auth, { type: 'bearer', token: '{{token}}' });
  assert.equal(r.collection.variables.find((v) => v.key === 'baseUrl').value, 'https://eu.shop.test/v2');
  // path parameters are request variables with the example as default
  assert.ok(!r.collection.variables.some((v) => v.key === 'userId'));
  assert.equal(r.requests.flatMap((q) => q.doc.variables).find((v) => v.key === 'userId').value, '42');
  assert.deepEqual(r.environments.map((e) => e.name), ['production', 'staging']);
  assert.deepEqual(r.environments[0].values, [
    { key: 'baseUrl', value: 'https://{{region}}.shop.test/v2', secret: false },
    { key: 'region', value: 'eu', secret: false },
    { key: 'token', value: '', secret: true },
    { key: 'apiKey', value: '', secret: true }, // used by one operation
  ]);
});

test('OpenAPI 3.1: operations', () => {
  const r = imp([['shop.yaml', v31]]);
  const by = (name) => r.requests.find((q) => q.doc.name === name);
  const list = by('List users');
  assert.equal(list.dir, 'requests/users');
  assert.equal(list.doc.url, '{{baseUrl}}/users');
  assert.deepEqual(list.doc.params.map((p) => [p.key, p.value, p.disabled]), [['limit', '20', true], ['q', 'ada', false]]);
  assert.deepEqual(list.doc.headers.map((h) => [h.key, h.disabled]), [['X-Trace', true], ['Cookie', true]]);
  assert.match(list.doc.docs, /operationId: `listUsers`/);
  assert.equal(list.doc.auth.type, 'inherit');

  const create = JSON.parse(by('Create user').doc.body.content);
  // readOnly id and the recursive manager (User → User) are left out
  assert.deepEqual(create, { name: 'Ada', email: 'user@example.com', tags: ['string'], role: 'admin', password: '' });

  const get = by('getUser');
  assert.equal(get.doc.url, '{{baseUrl}}/users/{{userId}}');
  assert.match(get.doc.docs, /^\*\*Deprecated\.\*\*\n\nOne user\./);

  const put = by('Replace user');
  assert.equal(put.dir, 'requests/users/admins');
  assert.deepEqual(put.doc.auth, { type: 'apikey', key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' });
  assert.deepEqual(JSON.parse(put.doc.body.content), { name: 'Ada Lovelace' });

  const upload = by('Upload order').doc.body;
  assert.equal(upload.type, 'multipart');
  assert.deepEqual(upload.fields.map((f) => [f.key, f.value, f.file]), [['note', 'urgent', ''], ['file', '', '']]);

  assert.deepEqual(by('Health').doc.auth, { type: 'none' });
  assert.equal(by('Health').dir, 'requests');
  assert.deepEqual(by('Login').doc.body.fields.map((f) => [f.key, f.value]), [['user', 'string'], ['pass', 'pw']]);
  assert.equal(by('Report').doc.body.type, 'xml');

  const w = r.warnings.join('\n');
  assert.match(w, /common\.yaml#\/components\/parameters\/Page was not resolved/);
  assert.match(w, /2 callbacks\/webhooks are described in the README/);
  assert.match(r.docs, /## Callbacks and webhooks/);
  assert.match(r.docs, /Callback `done` of `POST \/orders`: POST to `\{\$request\.body#\/url\}`/);
  assert.match(r.docs, /Webhook `newUser`: POST/);
  assert.match(w, /XML body has no example/);
});

test('external $ref resolved from a file selected together with the spec', () => {
  const common = 'components:\n  parameters:\n    Page: { name: page, in: query, required: true, schema: { type: integer, example: 3 } }\n';
  const r = imp([['shop.yaml', v31], ['common.yaml', common]]);
  assert.deepEqual(r.requests.find((q) => q.doc.name === 'External').doc.params.map((p) => [p.key, p.value]), [['page', '3']]);
  assert.doesNotMatch(r.warnings.join('\n'), /not resolved/);
});

test('Swagger 2.0', () => {
  const r = imp([['petstore.json', swagger]]);
  assert.equal(r.collection.variables[0].value, 'https://petstore.test/v1');
  assert.equal(r.environments[0].name, 'petstore-test');
  assert.deepEqual(r.collection.auth, { type: 'basic', username: '{{username}}', password: '{{password}}' });
  assert.deepEqual(r.environments[0].values.map((v) => [v.key, v.secret]), [['baseUrl', false], ['username', false], ['password', true]]);
  const [update, replace] = r.requests.map((q) => q.doc);
  assert.equal(update.name, 'updatePet');
  assert.equal(update.body.type, 'multipart');
  assert.deepEqual(update.body.fields.map((f) => [f.key, f.value]), [['name', 'Rex'], ['photo', '']]);
  assert.equal(replace.body.type, 'json');
  assert.deepEqual(JSON.parse(replace.body.content), { name: 'Rex', age: 0 });
  assert.deepEqual(replace.params.map((p) => [p.key, p.value, p.disabled]), [['dry', 'false', true]]);
  assert.deepEqual(update.variables.map((v) => [v.key, v.value]), [['petId', 'p1']]);
});

test('through the builder: files, environments, secrets', () => {
  const { files } = buildCollectionFiles(imp([['shop.yaml', v31]]));
  assert.equal(parseCollection(files['postbote.yaml']).doc.auth.token, '{{token}}');
  assert.ok(files['requests/users/admins/_folder.yaml']);
  assert.equal(parseRequest(files['requests/users/list-users.req.yaml']).doc.seq, 1);
  assert.deepEqual(parseEnv(files['environments/staging.env.pub']), [
    { key: 'baseUrl', value: 'https://staging.shop.test/v2' },
    { key: 'token', value: '' },
    { key: 'apiKey', value: '' },
  ]);
  assert.deepEqual(parseEnv(files['environments/staging.env']), [
    { key: 'token', value: '' },
    { key: 'apiKey', value: '' },
  ]);
});

test('secrets of operation-level schemes are declared, host names without dots', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Ops' },
    servers: [{ url: 'https://api.ops.test/v1' }],
    components: { securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'k' } } },
    paths: { '/a': { get: { security: [{ key: [] }] } } },
  };
  const r = imp([['ops.json', JSON.stringify(spec)]]);
  assert.equal(r.environments[0].name, 'api-ops-test');
  assert.deepEqual(r.environments[0].values.map((v) => [v.key, v.secret]), [['baseUrl', false], ['apiKey', true]]);
  assert.deepEqual(r.requests[0].doc.auth, { type: 'apikey', key: 'k', value: '{{apiKey}}', in: 'query' });
});

test('JSON bodies: string values are JSON strings, JSON text examples stay JSON', () => {
  const spec = (example, schema) => ({ openapi: '3.0.0', info: { title: 'B' }, paths: { '/a': { put: { requestBody: { content: { 'application/json': { schema, example } } } } } } });
  const body = (s) => imp([['b.json', JSON.stringify(s)]]).requests[0].doc.body.content;
  assert.equal(body(spec(undefined, { type: 'string', enum: ['.', 'X'] })), '"."');
  assert.equal(body(spec('{"a":1}', { type: 'object' })), '{\n  "a": 1\n}');
});

test('not a spec, no servers', () => {
  assert.throws(() => imp([['x.yaml', 'name: nope\n']]), /x.yaml: not a collection or API description.*selected together/);
  const r = imp([['min.json', JSON.stringify({ openapi: '3.0.3', info: { title: 'Min' }, paths: {} })]]);
  assert.equal(r.collection.variables[0].value, 'http://localhost');
  assert.match(r.warnings.join('\n'), /No server URL/);
  assert.match(r.warnings.join('\n'), /no operations/);
});
