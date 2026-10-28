# Roadmap

Collected 2026-10-28, updated as items land. Large items get their own branch (`feature/<name>`).

## Done

- Import: cURL paste (New request), Postman v2.x with environments, OpenAPI 3.x / Swagger 2.0
  ([import-export.md](import-export.md)).
- Settings page behind a gear icon; environment dropdown aligned.

## Large

| Topic | Scope | Plan |
| --- | --- | --- |
| Import / export, phase 2+ | Bruno, Insomnia, HAR, `.http`; `pm`/`bru` script compatibility layer (Postman scripts are imported as comments today); exports (Postman v2.1, `.http`); OpenAPI re-import / sync via the recorded `operationId` | [import-export.md](import-export.md) |
| Node workflows | Node-RED/n8n-style builder; request chains are called "Runner" since 0.1.3 | [node-workflows.md](node-workflows.md) |
| OAuth 2.0 / OIDC | auth type with Authorization Code + PKCE (login in browser/webview, local redirect), Client Credentials, Password, refresh tokens; tokens stored as private values, never in shared files. Postman and OpenAPI imports map OAuth to a plain bearer token until then | – |
| GraphQL | request type with query + variables editor, schema via introspection or file, autocomplete, code snippets (imports send GraphQL as a JSON body today) | – |

## Medium

| Topic | Scope |
| --- | --- |
| Cookie jar | keep cookies across requests per collection + environment; view/edit/clear in the UI; scripts get `cookies.get/set`; stored as private, not committed |
| OS keychain for secrets | private env values optionally in macOS Keychain / Windows Credential Manager / libsecret instead of plaintext `.env`; the `.env` file then holds a reference; server mode keeps the current behaviour |
| Nested variables | resolve `{{vars}}` inside variable values (e.g. `baseUrl=https://{{region}}.api.test`) in the runner and the UI preview, with a depth limit; OpenAPI server variables can then stay variables instead of fixed defaults |
| Binary request bodies | body type "file" (send a collection file as the raw body, e.g. `application/octet-stream` uploads); imports skip such bodies today |

## Small

- Folder order: folders sorted like the source (Postman item order, OpenAPI tag order) instead of
  alphabetically, e.g. a `seq` in `_folder.yaml`.
- Callbacks and webhooks from OpenAPI (requests the API sends to you): import as documentation or as
  example requests.

## Later

- Auto-update via the Tauri updater (signed update manifests) together with macOS notarization and Windows
  code signing (needs certificates/accounts); update check opt-in to keep "no telemetry".
