# Scripting

Scripts are JavaScript executed by QuickJS inside the POSTBote backend (ES2023: `let/const`, arrow
functions, destructuring, classes, template literals, …). Each script runs in its own function
scope, so `return` ends it early. There is no `require`, no network other than `postbote.sendRequest`,
and file access is limited to the collection. Every script has a timeout (`scriptTimeoutMs`,
default 10 s) and a run has a memory limit.

## Request (`req`) — pre-request scripts

```js
req.method = 'PUT';
req.url = vars.interpolate('{{baseUrl}}/v2/users');
req.setHeader('X-Signature', util.hmac('sha256', env.get('secret'), req.body));
req.removeHeader('Accept');
req.setParam('page', 2);
req.setJson({ ...req.json(), updatedAt: util.isoNow() });   // body helpers
req.headers;   // { name: value }
req.params;    // [{ key, value }]
```

Placeholders (`{{…}}`) are resolved **after** the pre-request scripts, so values set via `vars.set`
are picked up.

## Response (`res`) — post-response scripts

```js
res.status; res.statusText; res.timeMs; res.size;
res.headers['content-type'];  res.header('Content-Type');
res.body;      // text (base64 when res.encoding === 'base64')
res.json();    // parsed once, cached
```

## Tests

```js
test('status is 2xx', () => expect(res.status).toBeGreaterThanOrEqual(200));
test('user', () => {
  const u = res.json();
  expect(u).toHaveProperty('id');
  expect(u.roles).toContain('admin');
  expect(u.email).toMatch(/@example\.org$/);
  expect(u.deleted).not.toBeTruthy();
});
assert(res.status !== 500, 'server error');   // throws -> script error
```

Matchers: `toBe`, `toEqual` (deep), `toBeTruthy`, `toBeFalsy`, `toBeDefined`, `toBeUndefined`,
`toBeNull`, `toContain`, `toMatch`, `toBeGreaterThan(OrEqual)`, `toBeLessThan(OrEqual)`,
`toHaveProperty`, `toHaveLength`, `toBeOneOf`, `toBeType('string'|'number'|'array'|…)`, all
negatable with `.not`.

## Variables

```js
env.get('token'); env.set('token', value); env.unset('token'); env.all(); env.name;
vars.get('id'); vars.set('ids', [1, 2]); vars.has('id'); vars.unset('id'); vars.all();
vars.resolve('baseUrl');          // like {{baseUrl}}, through all scopes
vars.interpolate('{{baseUrl}}/x');
collection.name; collection.vars;
```

`env.set` persists to the private file of the active environment (`environments/<name>.env`,
gitignored) when the run ends; `env.get` sees shared and private values merged. `vars` hold any JSON value and
live for one run (a request run, or a whole runner) — the right place for tokens you do not want
on disk.

## Cookies

Cookies set by responses are kept per environment in `.cookies/<env>.json` (`_none` without an
environment; gitignored, never exported) and sent again by later requests, also across runs and app
restarts. View and clear them in the environment editor or under collection settings → Cookies.

```js
cookies.get('session');                         // value of the first matching cookie
cookies.get('session', 'https://api.example.com/');
cookies.all();                                  // [{ name, value, domain, path }]
cookies.set('debug', '1', 'https://api.example.com/');
cookies.clear();                                // empty the jar of the active environment
```

## Files, CSV, utilities

```js
const rows = csv.parse(fs.read('data/users.csv'));                 // [{name, role}, …]
const raw = csv.parse(text, { header: false, delimiter: ';' });    // [[…], …]
fs.write('out/report.csv', csv.stringify(rows));                   // columns from object keys
fs.writeJson('out/last.json', res.json());
fs.append('out/log.txt', `${util.isoNow()} ${res.status}\n`);
fs.readJson('data/config.json'); fs.exists('x'); fs.remove('x'); fs.list('data');

util.uuid(); util.now(); util.isoNow(); util.randomInt(1, 6);
util.base64Encode('a:b'); util.base64Decode('YTpi');
util.hash('sha256', text);             // sha1 | sha256 | sha512 | md5, hex
util.hmac('sha256', key, message);     // hex
util.sleep(500);                       // max 10 s

const r = postbote.sendRequest({ method: 'POST', url: 'https://auth.example.com/token', body: { grant_type: 'client_credentials' } });
vars.set('token', r.json().access_token);

console.log('anything', { objects: 'are pretty-printed' });
```

Files written by scripts appear in the collection immediately (browser collections store them in
the browser, disk collections on disk). Paths are relative to the collection root; `..` and `.git`
are rejected.

## Runners (`wf`)

```js
// pre-run: decide what to iterate over
wf.rows = csv.parse(fs.read('data/users.csv')).filter(u => u.active === 'true');

// in step scripts / conditions
wf.iteration;   // 0-based
wf.row;         // current data row (fields are also available as {{field}})
wf.results;     // [{ iteration, step, status, passed, error, timeMs }, …]
wf.last;        // response of the previous step
wf.goto('verify');    // continue with another step (after this one)
wf.skipIteration();   // next data row
wf.stop('reason');    // end the run (post-run script still runs)

// post-run: write a report
fs.write('out/report.json', JSON.stringify(wf.results, null, 2));
```
