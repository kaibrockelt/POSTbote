# Roadmap

Collected 2026-10-28, updated as items land. Large items get their own branch (`feature/<name>`).

## Done

- Import: cURL and raw HTTP paste (New request), Postman v2.x with environments, OpenAPI 3.x / Swagger
  2.0, `.http` files (JetBrains/VS Code), HAR, Bruno (folder, zip or JSON export) ([import-export.md](import-export.md)).
- Node-based workflows: canvas editor, engine, CLI ([../workflows.md](../workflows.md));
  next steps in [node-workflows.md](node-workflows.md).
- Cookie jar per environment (`.cookies/<env>.json`, gitignored, `cookies.*` in scripts).
- GraphQL body type (query + variables, sent as JSON envelope).
- Nested variables in configured values (`baseUrl=https://{{region}}.api.test`).
- Binary request bodies (body type `file`).
- Folders for runners and workflows; folder order kept from imports (`seq` in `_folder.yaml`).
- Settings page, collapsible sidebar sections, delete or move to trash everywhere.

## Large

| Topic | Scope | Plan |
| --- | --- | --- |
| OAuth 2.0 / OIDC | auth type with Authorization Code + PKCE (login in browser/webview, local redirect), Client Credentials, Password, refresh tokens; tokens stored as private values, never in shared files. Imports map OAuth to a plain bearer token until then | – |
| Import / export, phase 2+ | Bruno OpenCollection YAML (Bruno 3.1+), Insomnia; `pm`/`bru` script compatibility layer (Postman scripts are imported as comments today); exports (Postman v2.1, `.http`); OpenAPI re-import / sync via the recorded `operationId` | [import-export.md](import-export.md) |

## Medium

| Topic | Scope |
| --- | --- |
| OS keychain for secrets | private env values optionally in macOS Keychain / Windows Credential Manager / libsecret instead of plaintext `.env`; the `.env` file then holds a reference; server mode keeps the current behaviour |
| GraphQL comfort | schema via introspection or file, autocomplete and validation in the query editor; GraphQL in `.http` imports (`X-REQUEST-TYPE: GraphQL`) |

## Small

- OpenAPI callbacks/webhooks could also become example requests (today: listed in the README).

## Later

- Auto-update via the Tauri updater (signed update manifests) together with macOS notarization and Windows
  code signing (needs certificates/accounts); update check opt-in to keep "no telemetry".
