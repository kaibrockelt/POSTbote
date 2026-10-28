# Workflows (node-based)

A workflow is a graph of nodes in `workflows/**/<name>.workflow.yaml`, edited on a canvas in the app
(sidebar → Workflows). Values flow from a starter node along the edges: every node gets one input and
emits on an output port; all edges leaving that port are followed in order. Request chains over data
rows are a different feature, the [runner](collection-format.md) (`runners/`).

```yaml
name: Sync orders
nodes:
  - { id: start, type: manual, x: 60, y: 80, payloadType: json, payload: '{"ids": [1, 2, 3]}' }
  - { id: each, type: forEach, input: json, child: get, x: 300, y: 80 }
  - { id: get, type: call, input: json, request: requests/orders/get.req.yaml, x: 300, y: 240 }
  - { id: save, type: writeFile, path: out/orders.json, format: json, x: 560, y: 80 }
  - { id: done, type: return, x: 800, y: 80 }
edges:
  - { from: start, out: out, to: each }
  - { from: each, out: out, to: save }
  - { from: save, out: out, to: done }
```

## Inputs in requests

A request can use `{{input}}` or `{{input.field}}` (nested: `{{input.user.name}}`). Its **Inputs** tab
appears as soon as such a placeholder is used and holds sample values (saved as `inputs:` in the request
file) for sending it on its own; when a workflow calls the request, the node input replaces them.

## Values and ports

- A value has a type: `json`, `csv`, `text`, `file` (name, size, base64) or `none`. A node's `input`
  declares what it accepts (empty = anything); JSON text is converted to JSON where JSON is expected.
- Most nodes have `out` and `err`. An error goes to `err` as `{ "message", "node" }`; when `err` is not
  connected the workflow stops with that error.
- A Return node ends the workflow; its input is the result (or the value returned to a calling workflow).

## Nodes

| Type | Does |
| --- | --- |
| `manual` | Starter with a play button; its output is the payload (`payloadType` json, csv — rows with a header become JSON objects — or text). |
| `fromWorkflow` | Starter used when another workflow calls this one; output = the caller's input. |
| `call` | Runs a collection request. `{{input}}` / `{{input.field}}` work anywhere in the request; top-level fields of a JSON input override folder and collection variables of the same name, never environment values. `useFolder: false` ignores folder variables, headers, auth and scripts. Output = response body (JSON if it parses, else text). |
| `compute` | JavaScript with `input` (same sandbox as request scripts: `env`, `vars`, `fs`, `csv`, `util`); `return` gives the output, `throw` goes to `err`. |
| `switch` | `cases: [{ name, expr }]`; the first JS expression that is true picks the port `name`, else `default`. The input passes on unchanged. |
| `forEach` | Iterates a JSON array or CSV and runs the node `child` once per item (the child's own edges are not followed); outputs are collected into a JSON array. |
| `loadFile` | Reads `path` (may use `{{input.x}}` and environment values) inside the collection; `parse`: json, csv, text or file. |
| `writeFile` | Writes JSON or CSV input to `path` inside the collection (`format`: json or csv); passes the input on. |
| `makeCsv` | JSON array of objects → CSV text. |
| `workflow` | Calls another workflow (it needs a `fromWorkflow` starter) with the input; output = its Return value. Nesting is limited to 8 levels. |
| `return` | Ends the workflow with its input as result. |

Runs stop after 10 000 node executions. The CLI runs workflows too:
`postbote run path/to/collection workflows/sync.workflow.yaml --env staging`.
