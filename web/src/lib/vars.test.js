import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate } from './vars.js';

test('preview resolves nested configured variables, not runtime ones', () => {
  const scope = new Map(
    [
      ['baseUrl', 'https://{{host}}/v1', 'envpub'],
      ['host', 'api-{{region}}.test', 'env'],
      ['region', 'eu', 'collection'],
      ['loop', '{{loop}}', 'collection'],
      ['fromScript', '{{region}}', 'runtime'],
    ].map(([name, value, source]) => [name, { name, value, source }]),
  );
  assert.equal(interpolate('{{baseUrl}}/users', scope), 'https://api-eu.test/v1/users');
  assert.equal(interpolate('{{fromScript}}', scope), '{{fromScript}}');
  assert.equal(interpolate('{{loop}}', scope), '{{loop}}');
});
