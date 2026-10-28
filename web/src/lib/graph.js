// Node types of the workflow editor: label, group, output ports, the input
// types that make sense for the node ('' = any) and defaults for new nodes.
export const NODE_TYPES = {
  manual: { label: 'Manual start', group: 'Start', starter: true, inputs: [], outs: () => ['out'], init: { payloadType: 'json', payload: '{}' } },
  fromWorkflow: { label: 'From workflow', group: 'Start', starter: true, inputs: ['', 'json', 'csv', 'text', 'file'], outs: () => ['out'], init: { input: 'json' } },
  request: { label: 'Request', group: 'Actions', inputs: ['', 'json', 'text', 'none'], outs: () => ['out', 'err'], init: { input: 'json', request: '', useFolder: true } },
  script: { label: 'Script', group: 'Actions', inputs: ['', 'json', 'csv', 'text', 'file', 'none'], outs: () => ['out', 'err'], init: { code: 'return input;' } },
  setVar: { label: 'Set variable', group: 'Actions', inputs: ['', 'json', 'text'], outs: () => ['out', 'err'], init: { scope: 'vars', variable: '', value: '' } },
  transform: { label: 'Transform', group: 'Actions', inputs: ['', 'json', 'text', 'none'], outs: () => ['out', 'err'], init: { template: '{\n  "id": "{{input.id}}"\n}' } },
  loadFile: { label: 'Load file', group: 'Files', inputs: ['', 'json', 'none'], outs: () => ['out', 'err'], init: { path: 'data/', parse: 'json' } },
  writeFile: { label: 'Write file', group: 'Files', inputs: ['json', 'csv'], outs: () => ['out', 'err'], init: { input: 'json', path: 'out/result.json', format: 'json' } },
  makeCsv: { label: 'Make CSV', group: 'Files', inputs: ['json'], outs: () => ['out', 'err'], init: { input: 'json' } },
  switch: { label: 'Case / Switch', group: 'Control', inputs: ['', 'json', 'text'], outs: (n) => [...(n.cases || []).map((c) => c.name).filter(Boolean), 'default', 'err'], init: { cases: [{ name: 'yes', expr: 'input.ok === true' }] } },
  filter: { label: 'Filter', group: 'Control', inputs: ['', 'json', 'csv'], outs: () => ['out', 'err'], init: { input: 'json', expr: 'item.active' } },
  forEach: { label: 'For each', group: 'Control', inputs: ['', 'json', 'csv'], outs: () => ['out', 'err'], init: { input: 'json', child: '', parallel: false, limit: 5 } },
  assert: { label: 'Assert', group: 'Control', inputs: ['', 'json', 'text'], outs: () => ['out', 'err'], init: { checks: [{ expr: 'input !== null', message: '' }] } },
  delay: { label: 'Delay', group: 'Control', inputs: ['', 'json', 'csv', 'text', 'file', 'none'], outs: () => ['out'], init: { ms: 1000 } },
  workflow: { label: 'Run workflow', group: 'Control', inputs: ['', 'json', 'csv', 'text', 'file', 'none'], outs: () => ['out', 'err'], init: { workflow: '' } },
  return: { label: 'Return', group: 'End', inputs: ['', 'json', 'csv', 'text', 'file', 'none'], outs: () => [], init: {} },
};

export const outsOf = (n) => NODE_TYPES[n.type]?.outs(n) ?? ['out'];

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
