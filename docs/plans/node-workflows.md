# Plan: Node-based workflows (not started)

Status: first version on branch `feature/workflows` (2026-10-28): engine, canvas editor, CLI; see `docs/workflows.md`.
Done since: request Inputs tab, set variable / filter / assert / delay / transform / merge, parallel for each
(checkbox + limit), request errors and response mode, editor checks, folders.

## Next steps (noted 2026-10-29)

- **Assert as a test node:** report every check as a test result (✔/✘) in the workflow result, with a
  summary ("5 passed, 1 failed") in the panel and the CLI; option "report only, don't stop" so all checks
  run and the run still counts as failed (CI red). Without this, Script + throw and request tests cover it.
- **Request node:** retry (attempts + wait) and a timeout per node.
- **For each:** show results per item in the panel, not only the last one; real loop bodies (several
  nodes per item) instead of a single node or a Run workflow node.
- **Manual start:** configure like a call (params, headers, body, auth), as in the original idea.
- **Expressions:** label clearly where JavaScript (switch, filter, assert, script) and where `{{…}}`
  templates (set variable, transform, paths) are used.
- **Variables:** sub-workflows share `vars` with the caller; document it or give them their own scope.
- For i, While, Listen for request starter (port setting), zoom, multi-select, undo.

Still open from the original idea: For i, While, Listen for request, zoom.

## Terminology change

- What is called **"Workflows"** today (request chains with data-driven iterations, `workflows/**/*.flow.yaml`)
  becomes **"Runner"**.
- **"Workflows"** from now on means a node-based workflow builder in the style of Node-RED / n8n.
- Workflows use the selected environment like requests do.

## Node basics

- **Normal nodes** have exactly one input and usually two outputs.
- **Input:** a type dropdown (`CSV`, `JSON`, `text`, `file`, `none`). The node validates that the incoming
  payload has this type.
- **Outputs:** `stdout` and `errout`. If `errout` is not connected, an error aborts the workflow.

## Starter nodes (special)

- Start a workflow. At least one starter is mandatory. Several starters may exist, pointing to the same
  node or to different nodes.
- A starter has an optional node input and always a node output.
- Starter types:
  - **Manual:** a "Start workflow" button. Its output is configured like a call (params, headers, body,
    auth).
  - **FromWorkflow:** lets another workflow call this one, optionally with input from the caller. The input
    type must be declared here. Output = input.
  - Later, **Listen for request:** serves a local workflow API endpoint. Its port is an app-wide setting
    (see Settings page below).

## Normal nodes

### Call

- Runs a request from the collection; variables are resolved dynamically.
- Checkbox **"use folder settings"**, on by default: loads variables, settings, headers and scripts from the
  folder hierarchy.
- If the input is valid JSON, its fields may override **folder (and collection) variables, but never
  environment variables**. Security reason: a sideloaded input must not be able to redirect e.g.
  `baseUrl` and exfiltrate data.
- The response goes to `stdout`; errors while parsing/preparing the call go to `errout`.
- **`{{input.field}}` in requests:** usable in normal request editing too, not only in workflows.
  - When a request uses it, a new request tab **"Inputs"** shows a form to set values for local runs.
  - In workflows the JSON input fills these placeholders.
  - For `text` and `file` input a plain `{{input}}` is enough. CSV input is treated like text.

### Compute

- Runs code: reads the input, executes, produces output. Thrown errors go to `errout`.

### Load file

- Loads a file and optionally parses it. Parseable types are `json`, `csv` and `text`; other files are
  passed on as type `file`.
- The path field accepts variables from the input and the environment, e.g. a dynamic file name.

### Write file

- Writes the input to a file. Only CSV and JSON input at first; the input type forces the file type.

### Make CSV

- Expects a JSON array as input and outputs a CSV string.

### Workflow

- Calls another workflow, chosen from the list of workflows that have an active FromWorkflow starter.
- Passing input is optional.

## Control nodes

### Case / Switch

- Evaluates an expression on the input. Each case adds an output, so any number of outputs is possible.
- The output payload must be mappable.

## Loop nodes

- A loop node has a child node docked to it, which it loops over.
- All loop nodes collect the outputs of their child nodes as a JSON array and emit it as their output.
- **forEach:** iterates over a CSV or JSON array and accepts only those inputs. Checkbox **"async"**, off by
  default. When on, iterations run in parallel and a threshold field appears (max parallelism). Can run
  any standard node.
- **For i:** classic counter loop. `i` is a number or a variable; the node counts internally until `i` is
  reached.
- **While:** pre-check or post-check. Checks a condition on the input or on the output of the child nodes.

## Exit nodes

- Should be set but are not mandatory. Attach them to open ends, ideally all of them. A `return false` is
  especially useful on error paths.
- **Return:** receives its input and returns it. Without a parent workflow this is a clean exit.

## Related UI changes (from the same note)

- Replace the "Collections folder" link/button with a **gear icon**. Its modal becomes a **Settings page**
  for global settings: collections folder, and later the port for "Listen for request" starters, etc.
- The **environment dropdown** sits too far from the edge; align it flush with the neighbouring element.

## Decisions (2026-10-28)

- **Files and rename:** node workflows live in `workflows/**/*.workflow.yaml` (nodes, edges, positions);
  the current request chains move to `runners/**/*.runner.yaml`. No migration: the tool has no users yet.
- **Loop child:** exactly one node. Nesting with overview is what the Workflow node is for (a deep call,
  like calling a function). Recursion and endless loops are allowed on purpose; the existing run limits
  (max duration, memory, cancel) are the safety net, plus a call-depth limit to stop runaway recursion
  with a clear error.
- **Type `file`:** carries the content, not a path. Representation: `{ name, mime, size, bytes }`; in
  scripts `bytes` is a `Uint8Array`. Like n8n's binary data, the engine may transparently spill large
  payloads (above a threshold, e.g. 16 MB) to a temp file in the run directory and delete it after the
  run; nodes never see the difference. Binary call responses (e.g. JPEG) become `file` outputs.
- **Runners stay** for the classic data-driven use case, as long as they keep working cleanly.

## Open questions (to ask before coding)

1. Compute node: same QuickJS sandbox and API as request scripts (`env`, `vars`, `fs`, …) plus `input`
   and `output`?
2. Case/Switch "mappable output payload": pass the input through unchanged, or a per-case mapping
   expression?
3. May Write file and Load file leave the collection folder (sandbox today: collection only)?
4. Does the "Inputs" tab store its values in the request file, in the session, or in a private file?
5. CLI: `postbote run` for workflows with input from stdin/file?
