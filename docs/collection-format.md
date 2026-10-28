# Collection format

Everything is UTF-8 text. YAML files only contain fields that differ from the defaults, so diffs stay
small. Multi-line bodies and scripts are written as YAML block literals (`|`).

## `postbote.yaml`

```yaml
version: 1
name: My API
settings:
  commitEnvironments: false   # true: *.env files are committed as well
  timeoutMs: 30000            # request timeout
  scriptTimeoutMs: 10000      # per script
  followRedirects: true
  verifyTls: true
variables:                    # committed, non-secret defaults
  baseUrl: https://api.example.com
headers:
  - key: Accept
    value: application/json
auth:                         # default auth for all requests
  type: bearer
  token: "{{token}}"
scripts:
  pre: |                      # before every request
  post: |                     # after every request
```

## Folders: `requests/**/_folder.yaml`

Optional. Same keys as the collection: `name`, `variables`, `headers`, `auth`, `scripts`. Applied to
every request below the folder. An empty folder is kept alive by its `_folder.yaml` (git does not
track empty directories). `seq` orders folders within their parent like it orders requests (imports set
it to keep the source order); folders without `seq` are sorted by name.

## Requests: `requests/**/<name>.req.yaml`

```yaml
name: Create user
method: POST
url: "{{baseUrl}}/users"
params:                       # appended URL-encoded to the URL
  - key: dryRun
    value: "true"
    disabled: true            # kept, but not sent
headers:
  - key: X-Tenant
    value: "{{tenant}}"
auth:
  type: inherit               # inherit | none | bearer | basic | apikey
body:
  type: json                  # none | json | text | xml | form | multipart
  content: |
    {"name": "{{name}}"}
  # form / multipart use fields instead of content:
  # fields:
  #   - key: avatar
  #     file: data/avatar.svg   # multipart: send a collection file
scripts:
  pre: |
  post: |
docs: |
  Markdown documentation.
seq: 10                       # optional sort order in the sidebar
```

Auth types: `bearer` (`token`), `basic` (`username`, `password`), `apikey` (`key`, `value`,
`in: header|query`). An explicit `Authorization` header always wins over `auth`.

## Runners: `runners/**/<name>.runner.yaml`

```yaml
name: Onboard users
data: data/users.csv          # in data/: CSV/TSV with header row, or a JSON array; one iteration per row
settings:
  stopOnFailure: true         # stop when a step has an error, script error or failed test
  delayMs: 0                  # pause between steps
  maxIterations: 0            # 0 = all rows
scripts:
  pre: |                      # once, before the first iteration (may set wf.rows)
  post: |                     # once, after the last iteration
steps:
  - name: login               # used by wf.goto('login')
    request: requests/auth/login.req.yaml
    if: wf.iteration === 0    # optional JavaScript condition
  - name: create
    request: requests/users/create.req.yaml
    scripts:                  # run after the request's own pre/post scripts
      post: |
        if (res.status === 409) wf.goto('verify');
```

## Environments: `environments/<name>.env.pub` + `environments/<name>.env`

An environment is identified by its name and consists of up to two dotenv files:

| File | Contents | Git |
| --- | --- | --- |
| `<name>.env.pub` | shared values; declare every variable here, leave secrets empty | committed |
| `<name>.env` | private overrides (secrets, personal values) | ignored by the managed `.gitignore` block |

Private values override shared ones with the same name, except empty private values (`token=`
in the private file means “not set yet” and keeps a shared value). `env.set()` in scripts always
writes to the private file, so values obtained at runtime (tokens) never end up in git.

dotenv syntax: `KEY=value`, `# comments`, optional `export`, `"double quotes"` with `\n` escapes,
`'single quotes'` literal. Comments and order are kept when POSTBote updates a file.

Window tint: a comment line `# @tint #f38ba8` (hex `#rgb` or `#rrggbb`) tints the app window while the
environment is active, e.g. red for production. It is set in the environment editor and stored in the
shared file; a tint line in the private file overrides it for you alone.

## Variables

`{{name}}` works in URL, params, headers, body, form fields and auth. Lookup order:

1. runtime `vars` (set by scripts, live for one run/runner)
2. the current runner data row
3. the active environment: private values (`<name>.env`)
4. the active environment: shared values (`<name>.env.pub`)
5. folder variables (innermost first)
6. collection variables

Dynamic values: `{{$uuid}}`, `{{$timestamp}}`, `{{$timestampMs}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`.
Unknown names are left as-is; an unresolved variable in the URL is reported as an error.

Values from the environment, folders and the collection may use other variables, e.g.
`baseUrl=https://{{region}}.api.example.com` with `region=eu` (resolved up to four levels; cycles stay
unresolved). Values set at runtime or taken from data rows are inserted literally, so a response can
never make POSTBote insert a secret such as `{{token}}` into a later request.

## Script order

For each request: collection pre → folder pre (outer → inner) → request pre → runner step pre,
then the request is sent, then collection post → folder post → request post → runner step post.
