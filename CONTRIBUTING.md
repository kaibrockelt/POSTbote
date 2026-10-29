# Contributing to POSTBote

Thanks for helping! Bug reports, ideas, docs and code are all welcome.

## Before you start

- **Bugs and small fixes:** open an issue or send a pull request right away.
- **Larger features** (a new import format, a new node type, …): please open an issue first, so we can
  agree on the approach before you spend time on it. Planned topics are listed in
  [docs/plans/roadmap.md](docs/plans/roadmap.md).
- **Security issues:** do not open a public issue, see [SECURITY.md](SECURITY.md).

## Setup

You need a recent stable Rust toolchain and Node.js (LTS). The desktop app additionally needs the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) of your platform.

```bash
cd web && npm ci && npm run build          # UI (needed before cargo builds embed it)
cargo test                                 # core + server tests
cd web && npm test                         # UI tests
cargo run -p postbote-server -- local      # local app in the browser
cargo run -p postbote-desktop              # desktop app
```

For UI work, run the server and the Vite dev server side by side:

```bash
cargo run -p postbote-server -- serve --addr 127.0.0.1:8080 --auth none --data ./data
cd web && npm run dev                      # hot reload, proxies /api to :8080
```

The layout of the repository is described in the [README](README.md#architecture).

## Guidelines

- **Plain text first.** Collections are files people commit to git. Generated YAML omits empty fields,
  and opening a file must never rewrite it — keep diffs small.
- **Offline, no telemetry.** POSTBote must not phone home or need an account.
- **Security matters.** Scripts are sandboxed to their collection; values from responses, data rows or
  workflow inputs are never interpolated again. Keep it that way, and add a test when you touch it.
- **Tests:** add or update tests for behaviour changes (`crates/*/tests`, `web/src/**/*.test.js`). CI
  runs `npm test`, `cargo test --locked` and a desktop build.
- **UI changes:** try them in the browser (`postbote local` or the dev server) in light and dark mode
  before opening the pull request; screenshots in the PR help.
- **UI text is English.** Docs too.
- **Commits:** one topic per commit, a short imperative subject line (e.g. "Import Bruno collections"),
  details in the body if needed.

## Pull requests

1. Fork the repository and create a branch (`feature/<name>` or `fix/<name>`).
2. Make your change with tests and docs (`docs/` for the collection format, scripting and workflows).
3. Make sure `npm test` and `cargo test` pass.
4. Open the pull request and describe what changed and why.

## License

POSTBote is dual-licensed under MIT or Apache-2.0. Unless you explicitly state otherwise, any
contribution intentionally submitted for inclusion in POSTBote by you, as defined in the Apache-2.0
license, shall be dual licensed as above, without any additional terms or conditions.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
