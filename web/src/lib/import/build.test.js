import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectionFiles, countSecrets } from './build.js';
import { parseRequest, parseCollection, parseFolder, parseEnv } from '../format.js';

const result = () => ({
  name: 'Shop API',
  docs: 'The shop.',
  collection: { variables: [{ key: 'baseUrl', value: 'https://shop.test' }], auth: { type: 'bearer', token: 'col-secret' } },
  folders: [{ path: 'requests/orders', doc: { name: 'Orders' }, docs: 'Order endpoints.' }],
  requests: [
    { dir: 'requests/orders', doc: { name: 'List orders', method: 'GET', url: '{{baseUrl}}/orders', headers: [{ key: 'X-Api-Key', value: 'k1', file: '', disabled: false }] } },
    { dir: 'requests/orders', doc: { name: 'List orders', method: 'GET', url: '{{baseUrl}}/orders?all' } },
    { dir: 'requests', doc: { name: 'Ping', method: 'GET', url: '{{baseUrl}}/ping' } },
  ],
  environments: [{ name: 'Staging', values: [{ key: 'baseUrl', value: 'https://staging.shop.test' }, { key: 'password', value: 'pw', secret: true }] }],
  warnings: [],
});

test('builds a collection, secrets stay by default', () => {
  const { files } = buildCollectionFiles(result());
  assert.equal(parseCollection(files['postbote.yaml']).doc.name, 'Shop API');
  assert.equal(parseCollection(files['postbote.yaml']).doc.auth.token, 'col-secret');
  assert.equal(parseFolder(files['requests/orders/_folder.yaml']).doc.name, 'Orders');
  assert.equal(parseFolder(files['requests/orders/_folder.yaml']).doc.seq, 1);
  assert.equal(parseRequest(files['requests/orders/list-orders.req.yaml']).doc.seq, 1);
  assert.equal(parseRequest(files['requests/orders/list-orders-2.req.yaml']).doc.seq, 2);
  assert.equal(parseRequest(files['requests/ping.req.yaml']).doc.url, '{{baseUrl}}/ping');
  // secret environment values go to the private file, the shared one declares them
  assert.deepEqual(parseEnv(files['environments/staging.env.pub']), [
    { key: 'baseUrl', value: 'https://staging.shop.test' },
    { key: 'password', value: '' },
  ]);
  assert.deepEqual(parseEnv(files['environments/staging.env']), [{ key: 'password', value: 'pw' }]);
  assert.match(files['README.md'], /## Orders\n\nOrder endpoints\./);
  assert.match(files['.gitignore'], /\*\.env/);
});

test('literal secrets move into the chosen environment', () => {
  assert.equal(countSecrets(result()), 2);
  const { files, notes } = buildCollectionFiles(result(), { secretsEnv: 'Staging' });
  assert.equal(parseCollection(files['postbote.yaml']).doc.auth.token, '{{token}}');
  assert.equal(parseRequest(files['requests/orders/list-orders.req.yaml']).doc.headers[0].value, '{{apiKey}}');
  assert.deepEqual(parseEnv(files['environments/staging.env']), [
    { key: 'password', value: 'pw' },
    { key: 'token', value: 'col-secret' },
    { key: 'apiKey', value: 'k1' },
  ]);
  assert.match(notes[0], /2 tokens\/keys/);

  const fresh = buildCollectionFiles(result(), { secretsEnv: 'local' }).files;
  assert.deepEqual(parseEnv(fresh['environments/local.env']).map((v) => v.key), ['token', 'apiKey']);
});

test('folders keep the source order in the sidebar', async () => {
  const { buildTree } = await import('../tree.js');
  const r = result();
  r.folders = [
    { path: 'requests/users', doc: { name: 'Users' } },
    { path: 'requests/orders', doc: { name: 'Orders' } },
    { path: 'requests/users/admins', doc: { name: 'Admins' } },
  ];
  r.requests = [
    { dir: 'requests/users', doc: { name: 'A', method: 'GET', url: '/' } },
    { dir: 'requests/orders', doc: { name: 'B', method: 'GET', url: '/' } },
    { dir: 'requests/users/admins', doc: { name: 'C', method: 'GET', url: '/' } },
  ];
  const tree = buildTree(buildCollectionFiles(r).files);
  assert.deepEqual(tree.root.folders.map((f) => f.label), ['Users', 'Orders']);
  assert.deepEqual(tree.root.folders[0].folders.map((f) => f.label), ['Admins']);
});
