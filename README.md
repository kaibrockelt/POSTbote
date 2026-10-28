# POSTBote

An offline-first API client in the spirit of Postman and Bruno, built for digital sovereignty:
**no cloud, no account, no telemetry.** Collections, environments, runners and scripts are plain
text files that live in your folder (or your browser) and can be versioned with git.

- Collections with nested folders, inherited headers/variables/auth/scripts
- Environments as dotenv files: shared values in `<name>.env.pub` (committed) overlaid by private
  secrets in `<name>.env` (gitignored)
- Runners: request chains with data-driven iterations (CSV/JSON), conditions, `goto`/`stop`
- JavaScript scripting (QuickJS) before/after requests and before/after runners: read, iterate, write files
- Import: paste cURL or a raw HTTP request into a new request; Postman collections (v2.x, with
  environments), OpenAPI 3.x / Swagger 2.0, `.http` files (JetBrains/VS Code) and HAR as new collections,
  secrets moved into private environment values
- Desktop app (Tauri, system webview — no Electron), local browser mode, multi-user Docker server, CLI for CI

## Run it

### Desktop app

```bash
cd web && npm ci && npm run build && cd ..
cargo run --release -p postbote-desktop
```

A native window opens. On first start a short wizard asks where your collections live – by default
`~/Documents/POSTBote` (the platform's documents folder on Windows/Linux). Every collection is one
folder in there and shows up automatically; folders elsewhere (e.g. inside a project repository) can
be added as well. The choice is stored in the user config directory (`postbote/config.json`) and can be
changed later in Settings (gear icon in the top bar).

Installers for macOS/Windows/Linux are built with the Tauri CLI (`cargo install tauri-cli`,
then `cargo tauri build` inside `desktop/`). Linux needs WebKitGTK (`libwebkit2gtk-4.1`), Windows the
WebView2 runtime (preinstalled on Windows 10/11).

### Local mode in your browser (no webview needed)

```bash
cargo run --release -p postbote-server -- local
```

Starts on `127.0.0.1` with a random port and opens your browser with a one-time access token. Same
features and collections folder as the desktop app.

### Team server (Docker)

```bash
docker compose up -d
docker compose run --rm postbote user add alice
```

Open `http://localhost:8080`. Every user is isolated. By default a user's collections (including
environments) are stored **in their browser only** (IndexedDB) and can be exported/imported as zip.
Storing a collection on the server is an explicit opt-in per collection, and the admin can disable it
altogether (`POSTBOTE_NO_SERVER_STORAGE=true`). For browser-stored collections the server only receives
the files for the duration of a run and keeps nothing.

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTBOTE_ADDR` | `0.0.0.0:8080` | listen address |
| `POSTBOTE_DATA` | `/data` | users, session key, opt-in collections |
| `POSTBOTE_AUTH` | `local` | `local` (users via `postbote user add`), `header` (behind an auth proxy such as oauth2-proxy/Authelia), `none` |
| `POSTBOTE_AUTH_HEADER` | `X-Forwarded-User` | user header for `header` mode — only expose POSTBote through the proxy |
| `POSTBOTE_NO_SERVER_STORAGE` | `false` | disable opt-in server storage |
| `POSTBOTE_DENY_PRIVATE_NETWORKS` | `false` | block requests to private/loopback/link-local addresses (SSRF protection) |
| `POSTBOTE_MAX_RUN_SECONDS` | `600` | maximum duration of one run |
| `POSTBOTE_SCRIPT_MEMORY_MB` | `128` | memory limit of the script engine per run |
| `POSTBOTE_MAX_CONCURRENT_RUNS` | `32` | parallel runs |
| `POSTBOTE_SECURE_COOKIES` | `false` | set when served via HTTPS |

### CLI / CI

```bash
postbote run path/to/collection requests/users/get-user.req.yaml --env staging
postbote run path/to/collection runners/onboarding.runner.yaml --env staging --json
```

Exit code `1` when a request fails, a script throws or a test fails.

Try the bundled example: `postbote run examples/demo runners/onboarding.runner.yaml --env staging`.

## Collection format

A collection is a folder ([details](docs/collection-format.md)):

```text
my-api/
├── postbote.yaml                         # name, settings, variables, headers, auth, scripts
├── .gitignore                        # managed block: *.env stays local
├── environments/
│   ├── staging.env.pub               # shared values of "staging" (committed)
│   └── staging.env                   # private overrides/secrets of "staging" (gitignored)
├── requests/
│   └── users/
│       ├── _folder.yaml              # folder headers / variables / auth / scripts
│       └── get-user.req.yaml
├── runners/
│   └── onboarding.runner.yaml
└── data/users.csv                    # any text file, usable from scripts and runners
```

```yaml
# requests/users/get-user.req.yaml
name: Get user
method: GET
url: "{{baseUrl}}/users/{{userId}}"
headers:
  - key: Accept
    value: application/json
scripts:
  post: |
    test('status 200', () => expect(res.status).toBe(200));
    vars.set('userName', res.json().name);
```

Shared and private files of the same name form one environment; private values win. Exports leave
environments out unless chosen, and private values need an extra opt-in. Whether private files are
committed after all is a collection setting (`settings.commitEnvironments`), which rewrites only
POSTBote's block in `.gitignore`.

## Scripting

Scripts are JavaScript (ES2023, QuickJS) with `req`, `res`, `test`/`expect`, `env`, `vars`, `fs`, `csv`,
`util`, `postbote.sendRequest` and `wf`. See [docs/scripting.md](docs/scripting.md).

## Architecture

```text
crates/postbote-core     collection format, dotenv, runner (reqwest), scripting (rquickjs)
crates/postbote-server   axum API + embedded web UI; `postbote` binary (local | serve | run | user)
desktop/             Tauri shell: runs the local server in-process, shows it in the system webview
web/                 Svelte 5 UI (≈75 KB gzipped)
```

All requests are executed by the Rust backend (no CORS restrictions, scripts run sandboxed with time
and memory limits). The UI talks to the backend over a small JSON API.

Security model:

- **Local/desktop:** the server binds to `127.0.0.1` only and requires a random per-start token
  (exchanged for an `HttpOnly`, `SameSite=Strict` cookie). Mutating API calls require an `X-Postbote`
  header, so other websites cannot drive the API (no CORS is ever allowed).
- **Scripts** only see the files of their own collection (paths are sandboxed, symlinks out of the
  collection are rejected) and have no network access other than `postbote.sendRequest`.
- **Team server:** bcrypt-hashed users or an auth proxy, signed session cookies, per-user storage,
  optional SSRF protection, run/memory/concurrency limits.

## Releases

Pushing a version tag builds everything on GitHub Actions and creates a **draft release**:

```bash
scripts/bump-version.sh 0.2.0
git commit -am "Release 0.2.0" && git tag -a v0.2.0 -m v0.2.0 && git push --follow-tags
```

- Desktop app: macOS `.dmg` (universal), Windows `.exe`/`.msi`, Linux `.AppImage`/`.deb`/`.rpm`
- `postbote` CLI/server binaries for macOS, Windows and Linux (static, x86_64 + arm64)
- Docker image `ghcr.io/kaibrockelt/postbote` (amd64 + arm64)

Builds are unsigned by default (macOS ad-hoc signed). For notarized macOS builds add the Apple
secrets listed in [`.github/workflows/release.yml`](.github/workflows/release.yml) and set the
repository variable `MACOS_SIGNING=true`. Icons are generated from `desktop/icons/src/glyph.svg`
with `npm run icons` in `web/`.

## Development

```bash
cargo test                                  # core + server tests
cargo run -p postbote-server -- serve --addr 127.0.0.1:8080 --auth none --data ./data
cd web && npm run dev                       # UI with hot reload, proxies /api to :8080
```

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in POSTBote by you, as defined in the Apache-2.0 license, shall be dual licensed as
above, without any additional terms or conditions.
