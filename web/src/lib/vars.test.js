import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, variableScope, withRequestVars, shadowedByEnv } from './vars.js';
import { parseRequest, serializeRequest } from './format.js';

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

test('request variables: above folder and collection, below the environment; input is the sample', () => {
  const files = {
    'postbote.yaml': 'version: 1\nname: T\nvariables:\n  baseUrl: https://api.test\n  id: "1"\n',
    'environments/dev.env.pub': 'region=eu\n',
  };
  const text = 'name: R\nmethod: GET\nurl: "{{baseUrl}}/{{region}}/users/{{id}}?q={{input.q}}"\nvariables:\n  id: "7"\n  region: us\n  input: \'{"q": "kai"}\'\n';
  const doc = parseRequest(text).doc;
  assert.equal(serializeRequest(doc), text, 'round trip keeps the file unchanged');
  const base = variableScope(files, 'dev', 'requests/r.req.yaml');
  const scope = withRequestVars(base, doc);
  assert.equal(scope.get('id').source, 'request');
  assert.equal(scope.get('region').source, 'envpub');
  assert.deepEqual(shadowedByEnv(base, doc), ['region']);
  assert.equal(scope.get('input.q').value, 'kai');
  assert.equal(interpolate(doc.url, scope), 'https://api.test/eu/users/7?q=kai');
});
