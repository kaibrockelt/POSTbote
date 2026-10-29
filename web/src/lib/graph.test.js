import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGraph } from './graph.js';

test('workflow checks before running', () => {
  const doc = {
    nodes: [
      { id: 's', type: 'manual' },
      { id: 'r', type: 'request', request: 'requests/gone.req.yaml' },
      { id: 'e', type: 'forEach', child: 'c' },
      { id: 'c', type: 'request', request: 'requests/ok.req.yaml' },
      { id: 'x', type: 'script' },
      { id: 'both', type: 'return' },
      { id: 'm', type: 'merge' },
      { id: 'lonely', type: 'filter', expr: '' },
    ],
    edges: [
      { from: 's', out: 'out', to: 'r' },
      { from: 's', out: 'out', to: 'e' },
      { from: 'c', out: 'out', to: 'x' },
      { from: 'r', out: 'out', to: 'both' },
      { from: 'e', out: 'out', to: 'both' },
      { from: 'x', out: 'out', to: 'm' },
    ],
  };
  const { nodes, general } = checkGraph(doc, (p) => p === 'requests/ok.req.yaml');
  assert.deepEqual(general, []);
  assert.match(nodes.r.join(), /not found/);
  assert.match(nodes.c.join(), /own connections are not followed/);
  assert.match(nodes.both.join(), /Use a Merge node/);
  assert.match(nodes.m.join(), /at least two inputs/);
  assert.match(nodes.lonely.join(), /Not connected/);
  assert.match(nodes.lonely.join(), /filter expression/);
  assert.equal(nodes.e, undefined);
  assert.deepEqual(checkGraph({ nodes: [], edges: [] }, () => true).general.length, 1);
  // a connection into a loop child runs it a second time
  const into = checkGraph({ nodes: doc.nodes.slice(0, 4), edges: [...doc.edges.slice(0, 2), { from: 'r', out: 'out', to: 'c' }] }, () => true);
  assert.match(into.nodes.c.join(), /runs it once more/);
});
