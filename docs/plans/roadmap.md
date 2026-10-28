# Roadmap

Collected 2026-10-28. Nothing here is implemented yet. Large items get their own branch (`feature/<name>`).

## Large

| Topic | Scope | Plan |
| --- | --- | --- |
| Import / export | cURL paste with secret detection, Postman v2.1, OpenAPI / Swagger, later Bruno, Insomnia, HAR, `.http` | [import-export.md](import-export.md) |
| Node workflows | Node-RED/n8n-style builder; today's "workflows" become "Runner" | [node-workflows.md](node-workflows.md) |
| OAuth 2.0 / OIDC | auth type with Authorization Code + PKCE (login in browser/webview, local redirect), Client Credentials, Password, refresh tokens; tokens stored as private values, never in shared files | – |
| GraphQL | request type with query + variables editor, schema via introspection or file, autocomplete, code snippets | – |

## Medium

| Topic | Scope |
| --- | --- |
| Cookie jar | keep cookies across requests per collection + environment; view/edit/clear in the UI; scripts get `cookies.get/set`; stored as private, not committed |
| OS keychain for secrets | private env values optionally in macOS Keychain / Windows Credential Manager / libsecret instead of plaintext `.env`; the `.env` file then holds a reference; server mode keeps the current behaviour |

## Small

- Settings page behind a gear icon (replaces "Collections folder"); home for global settings such as the
  workflow listener port, later proxy/certificates.
- Environment dropdown flush with its neighbouring element.

## Later

- Auto-update via the Tauri updater (signed update manifests) together with macOS notarization and Windows
  code signing (needs certificates/accounts).
