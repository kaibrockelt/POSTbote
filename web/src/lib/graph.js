// Node types of the workflow editor: label, group, output ports, defaults.
export const NODE_TYPES = {
  manual: { label: 'Manual start', group: 'Start', starter: true, outs: () => ['out'], init: { payloadType: 'json', payload: '{}' } },
  fromWorkflow: { label: 'From workflow', group: 'Start', starter: true, outs: () => ['out'], init: { input: 'json' } },
  call: { label: 'Call request', group: 'Actions', outs: () => ['out', 'err'], init: { input: 'json', request: '', useFolder: true } },
  compute: { label: 'Compute', group: 'Actions', outs: () => ['out', 'err'], init: { code: 'return input;' } },
  loadFile: { label: 'Load file', group: 'Files', outs: () => ['out', 'err'], init: { path: 'data/', parse: 'json' } },
  writeFile: { label: 'Write file', group: 'Files', outs: () => ['out', 'err'], init: { input: 'json', path: 'out/result.json', format: 'json' } },
  makeCsv: { label: 'Make CSV', group: 'Files', outs: () => ['out', 'err'], init: { input: 'json' } },
  switch: { label: 'Case / Switch', group: 'Control', outs: (n) => [...(n.cases || []).map((c) => c.name).filter(Boolean), 'default', 'err'], init: { cases: [{ name: 'yes', expr: 'input.ok === true' }] } },
  forEach: { label: 'For each', group: 'Control', outs: () => ['out', 'err'], init: { input: 'json', child: '' } },
  workflow: { label: 'Run workflow', group: 'Control', outs: () => ['out', 'err'], init: { workflow: '' } },
  return: { label: 'Return', group: 'End', outs: () => [], init: {} },
};

export const INPUT_TYPES = ['', 'json', 'csv', 'text', 'file', 'none'];
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
