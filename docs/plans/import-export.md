# Plan: Import / Export (not started)

Status: researched 2026-10-28; base work started on branch `feature/import`.

## Formats

| Format | Notes | Priority |
| --- | --- | --- |
| OpenAPI 3.0 / 3.1 / 3.2, Swagger 2.0 | spec, not a collection: one request per operation; tags → folders (3.2 nested tags); servers → shared env per server (`baseUrl`); `{id}` → `{{id}}`; required params on, optional off; body from `example(s)` or generated from schema; security → collection auth, token in private env; resolve `$ref` incl. external files/URLs | 1 |
| Postman Collection v2.1 (JSON) + Postman environments | still the common exchange format; scripts use `pm.*`; env values of type `secret` / names like token, password, apiKey → private env (confirm in dialog) | 1 |
| cURL paste | bash + Windows cmd (`^`) variants, `-X -H -d --data-raw --data-binary --data-urlencode --json -F -u -b -G -L -k`, line continuations | 1 |
| Paste box extras | "Copy as fetch", raw HTTP request text, plain URL, pasted Postman/OpenAPI JSON | 1 |
| Bruno `.bru` + OpenCollection YAML | default since Bruno 3.1 (`opencollection.yml`, `folder.yml`, JSON schema at schema.opencollection.com); secret env vars → private | 2 |
| Insomnia v4 JSON / v5 YAML | template tags (`{% response %}`) not mappable → warn | 2 |
| HAR 1.2 | filter browser noise (`sec-*`, `:authority`, cookies), group by host | 2 |
| `.http` (JetBrains / VS Code REST Client) | same `{{var}}` syntax; `http-client.env.json` / `http-client.private.env.json` map to shared/private; response scripts as comments | 2 (import + export) |
| Postman Collection 3.0 (multi-file YAML, Postman v12) | `*.request.yaml`, `definition.yaml`, `.resources/` | 3 |

## Ideas

- **Secret detection on paste:** suggest `{{baseUrl}}` for the host and `{{token}}` for `Authorization` values; the value goes to the private env.
- **Script compatibility layer** in the prelude for `pm.*` (Postman) and `bru.*` / chai (Bruno), so imported scripts mostly run unchanged.
- **OpenAPI re-import / sync:** remember `operationId` → file and update without overwriting local edits.
- Exports: Postman v2.1 and `.http` worth it; OpenAPI from a collection is lossy (low priority).

## Architecture

- Import logic in Rust core (`postbote-core::import`), used by the UI, the server and a CLI command (`postbote import <file|url> --into <dir>`).
- One import dialog: file / URL (server mode: SSRF guard applies) / paste; auto-detects the format; shows a preview (tree, warnings, secret mapping) before writing; target = new collection or a folder of an existing one.
- Output is a plain file map in our format, so drafts/saving work as usual.

## Phases

1. Paste box (cURL, URL, raw HTTP, fetch) + secret detection; Postman v2.1 + envs; OpenAPI 3.x / Swagger 2 from file or URL.
2. `pm` / `bru` script shim; Bruno, Insomnia, HAR, `.http` import.
3. Export Postman v2.1 and `.http`; Postman 3.0; OpenAPI sync.

## Decisions (2026-10-28)

- **Branches:** `feature/import` holds the shared structure (importer registry, secret extraction,
  dialogs); every format gets its own branch off it (`feature/import-curl`, `feature/import-postman`,
  `feature/import-openapi`, …) so formats can be extended and released independently.
- **cURL (and other single requests):** pasted into an optional second field of the "New request"
  dialog; creates one request in the current collection, never a collection.
- **Collection formats (Postman, OpenAPI, …):** always create a new collection (the "Add a
  collection" dialog, next to zip import), never a folder in an existing one.
- **Postman scripts:** imported as comments first; a `pm` compatibility layer comes later on its own
  branch.
- **OpenAPI sync:** later; the import already records the origin (`operationId`) so a sync is possible.
- **Where parsing runs:** in the web UI (`web/src/lib/import/`), so the one serializer in `format.js`
  writes the files and browser-stored collections work the same; a CLI import would need a Rust port.
