// Node types of the workflow editor: label, group, output ports, the input
// types that make sense for the node ('' = any) and defaults for new nodes.
export const NODE_TYPES = {
  manual: { label: 'Manual start', group: 'Start', starter: true, inputs: [], outs: () => ['out'], init: { payloadType: 'json', payload: '{}' } },
  fromWorkflow: { label: 'From workflow', group: 'Start', starter: true, inputs: ['', 'json', 'csv', 'text', 'file'], outs: () => ['out'], init: { input: 'json' } },
  request: { label: 'Request', group: 'Actions', inputs: ['', 'json', 'text', 'none'], outs: () => ['out', 'err'], init: { input: 'json', request: '', useFolder: true, failOnError: true, output: 'body' } },
  script: { label: 'Script', group: 'Actions', inputs: ['', 'json', 'csv', 'text', 'file', 'none'], outs: () => ['out', 'err'], init: { code: 'return input;' } },
  setVar: { label: 'Set variable', group: 'Actions', inputs: ['', 'json', 'text'], outs: () => ['out', 'err'], init: { scope: 'vars', variable: '', value: '' } },
  transform: { label: 'Transform', group: 'Actions', inputs: ['', 'json', 'text', 'none'], outs: () => ['out', 'err'], init: { template: '{\n  "id": "{{input.id}}"\n}' } },
  loadFile: { label: 'Load file', group: 'Files', inputs: ['', 'json', 'none'], outs: () => ['out', 'err'], init: { path: 'data/', parse: 'json' } },
  writeFile: { label: 'Write file', group: 'Files', inputs: ['json', 'csv'], outs: () => ['out', 'err'], init: { input: 'json', path: 'out/result.json', format: 'json' } },
  makeCsv: { label: 'Make CSV', group: 'Files', inputs: ['json'], outs: () => ['out', 'err'], init: { input: 'json' } },
  switch: { label: 'Case / Switch', group: 'Control', inputs: ['', 'json', 'text'], outs: (n) => [...(n.cases || []).map((c) => c.name).filter(Boolean), 'default', 'err'], init: { cases: [{ name: 'yes', expr: 'input.ok === true' }] } },
  filter: { label: 'Filter', group: 'Control', inputs: ['', 'json', 'csv'], outs: () => ['out', 'err'], init: { input: 'json', expr: 'item.active' } },
  merge: { label: 'Merge', group: 'Control', inputs: [], outs: () => ['out'], init: { mode: 'object' } },
  forEach: { label: 'For each', group: 'Control', inputs: ['', 'json', 'csv'], outs: () => ['out', 'err'], init: { input: 'json', child: '', parallel: false, limit: 5 } },
  assert: { label: 'Assert', group: 'Control', inputs: ['', 'json', 'text'], outs: () => ['out', 'err'], init: { checks: [{ expr: 'input !== null', message: '' }] } },
  delay: { label: 'Delay', group: 'Control', inputs: ['', 'json', 'csv', 'text', 'file', 'none'], outs: () => ['out'], init: { ms: 1000 } },
  workflow: { label: 'Run workflow', group: 'Control', inputs: ['', 'json', 'csv', 'text', 'file', 'none'], outs: () => ['out', 'err'], init: { workflow: '' } },
  return: { label: 'Return', group: 'End', inputs: ['', 'json', 'csv', 'text', 'file', 'none'], outs: () => [], init: {} },
};

export const outsOf = (n) => NODE_TYPES[n.type]?.outs(n) ?? ['out'];

/**
 * Checks a workflow before it runs: { nodes: { id: [message] }, general: [message] }.
 * `exists(path)` tells whether a collection file exists.
 */
export function checkGraph(doc, exists) {
  const nodes = {};
  const general = [];
  const add = (id, msg) => (nodes[id] ||= []).push(msg);
  const incoming = (id) => doc.edges.filter((e) => e.to === id);
  const outgoing = (id) => doc.edges.filter((e) => e.from === id);
  const children = new Set(doc.nodes.filter((n) => n.type === 'forEach' && n.child).map((n) => n.child));
  if (!doc.nodes.some((n) => n.type === 'manual' || n.type === 'fromWorkflow')) general.push('No starter: add a Manual start (or From workflow) node.');
  for (const n of doc.nodes) {
    const t = NODE_TYPES[n.type];
    if (!t) {
      add(n.id, `Unknown node type “${n.type}”.`);
      continue;
    }
    const ins = incoming(n.id);
    if (!t.starter && !ins.length && !children.has(n.id)) add(n.id, 'Not connected: this node never runs.');
    if (n.type !== 'merge' && new Set(ins.map((e) => e.from)).size > 1) add(n.id, 'Several inputs: runs once per input. Use a Merge node to wait for all of them.');
    if (n.type === 'merge' && ins.length < 2) add(n.id, 'Connect at least two inputs to merge.');
    if (n.type === 'request') {
      if (!n.request) add(n.id, 'Choose a request.');
      else if (!exists(n.request)) add(n.id, `Request ${n.request} not found.`);
    }
    if (n.type === 'workflow') {
      if (!n.workflow) add(n.id, 'Choose a workflow.');
      else if (!exists(n.workflow)) add(n.id, `Workflow ${n.workflow} not found.`);
    }
    if (n.type === 'forEach') {
      const child = doc.nodes.find((c) => c.id === n.child);
      if (!n.child) add(n.id, 'Choose the node to run for every item.');
      else if (!child) add(n.id, `Loop node ${n.child} not found.`);
      else if (outgoing(child.id).length) add(child.id, 'Runs inside “For each”: its own connections are not followed (select and delete them). For several steps per item, loop over a Run workflow node.');
      else if (incoming(child.id).length) add(child.id, 'Runs inside “For each”, which passes it every item: a connection into it runs it once more on its own (select and delete it).');
    }
    if (n.type === 'setVar' && !String(n.variable || '').trim()) add(n.id, 'Set the variable name.');
    if (n.type === 'filter' && !String(n.expr || '').trim()) add(n.id, 'Set the filter expression.');
    if (n.type === 'switch' && !(n.cases || []).some((c) => c.name && String(c.expr || '').trim())) add(n.id, 'Add a case (port name and expression).');
    if ((n.type === 'loadFile' || n.type === 'writeFile') && !String(n.path || '').trim()) add(n.id, 'Set the file path.');
  }
  return { nodes, general };
}

export function newGraphDoc(name) {
  return {
    name,
    nodes: [
      { id: 'start', type: 'manual', name: 'Start', x: 60, y: 80, ...NODE_TYPES.manual.init },
      { id: 'done', type: 'return', name: 'Done', x: 420, y: 80 },
    ],
    edges: [{ from: 'start', out: 'out', to: 'done' }],
  };
}

export function uniqueNodeId(doc, type) {
  let i = 1;
  while (doc.nodes.some((n) => n.id === `${type}${i}`)) i++;
  return `${type}${i}`;
}
