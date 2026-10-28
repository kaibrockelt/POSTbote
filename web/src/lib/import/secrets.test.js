import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSecrets, useKnownVars } from './secrets.js';
import { nameFromUrl } from './index.js';

test('secrets become variables', () => {
  const doc = {
    url: 'https://api.example.com/users?api_key=abc&page=2',
    auth: { type: 'bearer', token: 's3cr3t' },
    headers: [
      { key: 'Authorization', value: 'Bearer s3cr3t' },
      { key: 'X-Api-Key', value: 'k1' },
      { key: 'Accept', value: 'application/json' },
      { key: 'Cookie', value: '{{session}}' },
    ],
    params: [
      { key: 'api_key', value: 'abc' },
      { key: 'page', value: '2' },
    ],
  };
  const found = extractSecrets(doc);
  assert.equal(doc.auth.token, '{{token}}');
  assert.equal(doc.headers[0].value, 'Bearer {{token}}'); // same value, same name
  assert.equal(doc.headers[1].value, '{{apiKey}}');
  assert.equal(doc.headers[2].value, 'application/json');
  assert.equal(doc.headers[3].value, '{{session}}');
  assert.equal(doc.params[0].value, '{{apiKey2}}'); // different value, new name
  assert.equal(doc.params[1].value, '2');
  assert.deepEqual(
    found.map((f) => [f.key, f.value]),
    [
      ['token', 's3cr3t'],
      ['apiKey', 'k1'],
      ['apiKey2', 'abc'],
    ],
  );
});

test('cookie templates without values are no secret', () => {
  const doc = { headers: [{ key: 'Cookie', value: 'session=; theme=' }], params: [] };
  assert.deepEqual(extractSecrets(doc), []);
  const real = { headers: [{ key: 'Cookie', value: 'session=abc' }], params: [] };
  assert.deepEqual(extractSecrets(real).map((f) => f.key), ['cookie']);
});

test('secret form fields', () => {
  const doc = { headers: [], params: [], body: { type: 'form', fields: [{ key: 'client_id', value: 'abc' }, { key: 'client_secret', value: 'ssh' }] } };
  assert.deepEqual(extractSecrets(doc).map((f) => [f.key, f.value]), [['clientSecret', 'ssh']]);
  assert.equal(doc.body.fields[0].value, 'abc');
  assert.equal(doc.body.fields[1].value, '{{clientSecret}}');
});

test('existing variable names are reused, filled or avoided', () => {
  const doc = { auth: { type: 'bearer', token: 'new' }, headers: [], params: [] };
  extractSecrets(doc, new Map([['token', 'old']]));
  assert.equal(doc.auth.token, '{{token2}}');

  const declared = { auth: { type: 'bearer', token: 'tok' }, headers: [], params: [] };
  assert.deepEqual(extractSecrets(declared, new Map([['token', '']])).map((f) => f.key), ['token']);
  assert.equal(declared.auth.token, '{{token}}');

  const same = { auth: { type: 'bearer', token: 'tok' }, headers: [], params: [] };
  assert.deepEqual(extractSecrets(same, new Map([['token', 'tok']])), []); // already stored
  assert.equal(same.auth.token, '{{token}}');
});

test('known base URL is replaced by its variable', () => {
  const doc = { url: 'https://api.example.com/v1/users/7' };
  const vars = [
    { name: 'host', value: 'https://api.example.com' },
    { name: 'baseUrl', value: 'https://api.example.com/v1/' },
    { name: 'other', value: 'https://api.example.co' },
  ];
  assert.equal(useKnownVars(doc, vars), 'baseUrl');
  assert.equal(doc.url, '{{baseUrl}}/users/7');
  const d2 = { url: 'https://api.example.community/x' };
  assert.equal(useKnownVars(d2, vars), null);
});

test('names from URLs', () => {
  assert.equal(nameFromUrl('POST', 'https://x.io/api/users?x=1'), 'POST api/users');
  assert.equal(nameFromUrl('GET', '{{baseUrl}}/'), 'GET /');
});
