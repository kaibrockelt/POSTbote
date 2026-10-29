# POSTBote

Offline-first API client (Postman/Bruno alternative). Collections, environments, runners and scripts are plain text files, versionable with git. No cloud.

## Layout

- `crates/postbote-core` – collection format (`model.rs`), dotenv (`dotenv.rs`), sandboxed file access (`fs.rs`: `DiskFs`, `MemFs`, `Overlay`, `Tracking`), runner (`runner/`: reqwest blocking HTTP, QuickJS via rquickjs). Scripts talk to Rust through a single `__host(op, argsJson)` function; the script API lives in `runner/prelude.js`, native ops in `runner/host.rs`.
- `crates/postbote-server` – axum API + embedded web UI (rust-embed of `web/dist`), binary `postbote` (`local` | `serve` | `run` | `user`). `workspaces.rs` = collections on disk (local: collections folder + external folders + session files in `<config>/postbote/`; server: per-user dirs). `api.rs` = routes, CSRF via `X-Postbote` header, local token cookie.
- `desktop/` – Tauri 2 shell: starts the local server in-process and opens it in the system webview. Icons are generated (`cd web && npm run icons`, source `desktop/icons/src/glyph.svg`).
- `web/` – Svelte 5 (runes) + Vite, plain JS. State in `src/lib/state.svelte.js` (files map, drafts, tabs, session), formats in `src/lib/format.js` (YAML/dotenv parse/serialize, scaffold), variable scope/highlighting in `src/lib/vars.js` + `components/VarField.svelte`, sidebar actions in `src/lib/actions.js`.
- `examples/demo` – sample collection; `docs/` – collection format, scripting, plans (`docs/plans/`).

## Collection format (summary)

`postbote.yaml`, `requests/**/<name>.req.yaml`, `requests/**/_folder.yaml`, `runners/**/<name>.runner.yaml`, `workflows/**/<name>.workflow.yaml`, `environments/<name>.env.pub` (shared, committed) + `environments/<name>.env` (private, gitignored, overrides; empty private value keeps shared; `env.set()` writes private). Variable lookup: runtime vars > data row > private env > shared env > workflow input > folder > collection; configured values may nest `{{vars}}`, runtime/input values never do. Cookies per environment in `.cookies/` (gitignored). Details: `docs/collection-format.md`, `docs/scripting.md`.

## Commands

```bash
cd web && npm ci && npm run build          # UI (needed before cargo builds embed it)
cargo test                                 # core + server tests
cargo run -p postbote-server -- local      # local app in the browser
cargo run -p postbote-server -- serve --addr 127.0.0.1:8080 --auth none --data ./data
cargo run -p postbote-desktop              # desktop app
cd web && npm run dev                      # UI dev server, proxies /api to :8080
scripts/bump-version.sh X.Y.Z              # version in Cargo, Tauri, web
```

Releases: push tag `vX.Y.Z` → `.github/workflows/release.yml` builds Tauri bundles, CLI binaries, Docker image into a draft release. No `-alpha` suffix (breaks Windows MSI).

## Conventions

- Editors never write files directly: they write drafts (`setDraft`), files change on save (`saveTab`). Runs send drafts as `overrides`.
- Generated YAML omits empty fields to keep git diffs small; opening a file must not rewrite it.
- UI text is English; the user talks German.
- Test UI changes in the browser (local mode with an isolated `HOME`, e.g. in the scratchpad) before reporting done.
- Larger features (import, node workflows, …) on their own branch (`feature/<name>`); small fixes and docs may go to main.
- Commit only when asked; end commit messages with the Co-Authored-By line.

## Next up

Full list of planned topics: `docs/plans/roadmap.md`.

Import phase 1 is done (cURL/raw HTTP paste, Postman, OpenAPI, `.http`, HAR; `web/src/lib/import/`, one module per format, shared builder and secret handling). Remaining phases in `docs/plans/import-export.md`.

Terminology: request chains over data rows are **runners** (`runners/**/*.runner.yaml`; internally still `workflow`: kind, `Target::Workflow`, `WorkflowEditor`, script object `wf`). **Workflows** are the node-based flows (`workflows/**/*.workflow.yaml`, internally `graph`: `runner/graph.rs`, `Target::Graph`, `GraphEditor`, tab kind `graph`), see `docs/workflows.md`; later steps in `docs/plans/node-workflows.md`.
