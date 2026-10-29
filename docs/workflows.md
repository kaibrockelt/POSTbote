# Workflows (node-based)

A workflow is a graph of nodes in `workflows/**/<name>.workflow.yaml`, edited on a canvas in the app
(sidebar → Workflows; folders like for requests, moved by drag & drop or "Move to"). Values flow from a starter node along the edges: every node gets one input and
emits on an output port; all edges leaving that port are followed in order. Request chains over data
rows are a different feature, the [runner](collection-format.md) (`runners/`).

```yaml
name: Sync orders
nodes:
  - { id: start, type: manual, x: 60, y: 80, payloadType: json, payload: '{"ids": [1, 2, 3]}' }
  - { id: each, type: forEach, input: json, child: get, x: 300, y: 80 }
  - { id: get, type: request, input: json, request: requests/orders/get.req.yaml, x: 300, y: 240 }
  - { id: save, type: writeFile, path: out/orders.json, format: json, x: 560, y: 80 }
  - { id: done, type: return, x: 800, y: 80 }
edges:
  - { from: start, out: out, to: each }
  - { from: each, out: out, to: save }
  - { from: save, out: out, to: done }
```

## Requests as functions: request variables

A request declares its parameters in its **Variables** tab (`variables:` in the request file) and uses
them like any variable: `{{userId}}`. Sent on its own, the defaults apply. Called by a workflow, the top-level
fields of a JSON input fill the declared variables of the same name — and nothing else: folder,
collection and environment values cannot be changed by an input. Environment values also win over
request variables. Values from an input are inserted literally, never resolved again.

`{{input}}` (the whole input, also text or CSV) and `{{input.field}}` (nested: `{{input.user.name}}`)
read the node input directly. For sending the request on its own, the request variable `input` holds a
sample (JSON is parsed, so `{{input.field}}` works too).

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
| `request` | Runs a collection request. Top-level fields of a JSON input fill the request's declared variables (shown on the node); `{{input}}` / `{{input.field}}` work anywhere in the request. `useFolder: false` ignores folder variables, headers, auth and scripts. Output = response body (JSON if it parses, else text), or with `output: response` the object `{ status, headers, body }`. HTTP status ≥ 400 and failed tests go to `err` unless `failOnError: false`. |
| `script` | JavaScript with `input` (same sandbox as request scripts: `env`, `vars`, `fs`, `csv`, `util`); `return` gives the output, `throw` goes to `err`. |
| `setVar` | Stores `value` (a template, e.g. `{{input.access_token}}`; empty = the whole input) as `variable` in the run variables (`scope: vars`) or the private environment values (`scope: env`). Later requests use it as `{{variable}}`. Passes the input on. |
| `transform` | Builds the output from `template` — JSON (or text) with `{{input.x}}` and other variables. |
| `switch` | `cases: [{ name, expr }]`; the first JS expression that is true picks the port `name`, else `default`. The input passes on unchanged. |
| `filter` | Keeps the items of a JSON array or CSV for which `expr` (JS with `item`, `index`) is true. |
| `merge` | Waits until every connected node delivered a value, then continues once with all of them: an object keyed by source node id (`mode: object`) or an array in connection order (`mode: array`). |
| `forEach` | Iterates a JSON array or CSV and runs the node `child` once per item (the child's own edges are not followed); outputs are collected into a JSON array. `parallel: true` sends Request children at the same time, at most `limit` (default 5) at once; their scripts still run one after another. |
| `assert` | `checks: [{ expr, message }]` — all JS expressions must be true, else the node goes to `err` (unconnected: the workflow fails, CLI exit code 1). |
| `delay` | Waits `ms` milliseconds (number or template), then passes the input on. |
| `loadFile` | Reads `path` (may use `{{input.x}}` and environment values) inside the collection; `parse`: json, csv (rows with a header become JSON objects), text or file. |
| `writeFile` | Writes JSON or CSV input to `path` inside the collection (`format`: json or csv); passes the input on. |
| `makeCsv` | JSON array of objects → CSV text. |
| `workflow` | Calls another workflow (it needs a `fromWorkflow` starter) with the input; output = its Return value. Nesting is limited to 8 levels. |
| `return` | Ends the workflow with its input as result. |

Branches: several edges from one port run one after another; a node with several inputs runs once per
input — use `merge` to wait for all of them. A node run by `forEach` does not follow its own edges; for
several steps per item, loop over a `workflow` node. The editor marks such problems (and missing requests,
unconnected nodes, …) with a dashed yellow border before you run.

Runs stop after 10 000 node executions. The CLI runs workflows too:
`postbote run path/to/collection workflows/sync.workflow.yaml --env staging`.
