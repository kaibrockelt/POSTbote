use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use postbote_core::fs::{Fs, MemFs};
use postbote_core::runner::{RunOptions, Target, run};

/// Minimal HTTP echo server: answers every request with a JSON description of it.
fn echo_server() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in l.incoming().flatten() {
            std::thread::spawn(move || {
                let mut rd = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                rd.read_line(&mut line).unwrap();
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let mut headers = serde_json::Map::new();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    rd.read_line(&mut h).unwrap();
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = h.split_once(':') {
                        let k = k.trim().to_lowercase();
                        if k == "content-length" {
                            len = v.trim().parse().unwrap();
                        }
                        headers.insert(k, v.trim().into());
                    }
                }
                let mut body = vec![0; len];
                rd.read_exact(&mut body).unwrap();
                if path.starts_with("/slow") {
                    std::thread::sleep(Duration::from_millis(300));
                }
                let status = if path.starts_with("/status/404") { "404 Not Found" } else { "200 OK" };
                let out = serde_json::json!({
                    "method": method, "path": path, "headers": headers,
                    "body": String::from_utf8_lossy(&body),
                })
                .to_string();
                let mut s = stream;
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                );
            });
        }
    });
    format!("http://{addr}")
}

fn collection(base: &str, extra: &[(&str, &str)]) -> Box<dyn Fs> {
    let mut files = BTreeMap::new();
    files.insert(
        "postbote.yaml".to_string(),
        format!("version: 1\nname: Test\nvariables:\n  baseUrl: {base}\nheaders:\n  - key: X-Col\n    value: col\n"),
    );
    files.insert("environments/dev.env.pub".to_string(), "token=\nregion=eu\n".to_string());
    files.insert("environments/dev.env".to_string(), "# dev\ntoken=abc\n".to_string());
    for (k, v) in extra {
        files.insert(k.to_string(), v.to_string());
    }
    Box::new(MemFs::new(files).unwrap())
}

fn opts() -> RunOptions {
    RunOptions { env: Some("dev".into()), ..Default::default() }
}

#[test]
fn request_with_scripts_tests_and_env_persistence() {
    let base = echo_server();
    let fs = collection(
        &base,
        &[
            ("requests/users/_folder.yaml", "headers:\n  - key: X-Folder\n    value: '{{token}}'\nauth:\n  type: bearer\n  token: '{{token}}'\n"),
            (
                "requests/users/create.req.yaml",
                r#"name: Create
method: post
url: "{{baseUrl}}/users"
params:
  - key: q
    value: a b
  - key: off
    value: x
    disabled: true
body:
  type: json
  content: '{"name": "{{name}}"}'
scripts:
  pre: |
    vars.set('name', 'Ada');
    req.setHeader('X-Pre', util.hash('sha256', 'x').slice(0, 6));
    console.log('pre', {a: 1});
  post: |
    const j = res.json();
    test('status ok', () => expect(res.status).toBe(200));
    test('body interpolated', () => expect(JSON.parse(j.body)).toEqual({name: 'Ada'}));
    test('headers merged', () => {
      expect(j.headers['x-col']).toBe('col');
      expect(j.headers['x-folder']).toBe('abc');
      expect(j.headers['authorization']).toBe('Bearer abc');
      expect(j.headers['x-pre']).toBe('2d7116');
    });
    test('query', () => expect(j.path).toBe('/users?q=a+b'));
    test('shared env value', () => expect(env.get('region')).toBe('eu'));
    test('fails on purpose', () => expect(1).not.toBe(1));
    env.set('token', 'new "token"');
    env.set('fresh', 42);
    fs.write('out/result.json', j);
"#,
            ),
        ],
    );
    let out = run(fs, Target::Request("requests/users/create.req.yaml".into()), opts());
    assert!(out.error.is_none(), "{:?}", out.error);
    let r = out.request.unwrap();
    assert!(r.error.is_none(), "{:?} {:?}", r.error, r.script_errors);
    assert_eq!(r.request.as_ref().unwrap().method, "POST");
    let names: Vec<_> = r.tests.iter().map(|t| (t.name.as_str(), t.passed)).collect();
    assert_eq!(
        names,
        vec![
            ("status ok", true),
            ("body interpolated", true),
            ("headers merged", true),
            ("query", true),
            ("shared env value", true),
            ("fails on purpose", false)
        ],
        "{:#?}",
        r.tests
    );
    assert_eq!(r.logs[0].message, "pre {\n  \"a\": 1\n}");
    let env = out.changed_files["environments/dev.env"].clone().unwrap();
    assert_eq!(env, "# dev\ntoken=\"new \\\"token\\\"\"\nfresh=42\n");
    assert!(!out.changed_files.contains_key("environments/dev.env.pub"), "env.set must not touch the shared file");
    assert!(out.changed_files["out/result.json"].as_ref().unwrap().contains("\"method\": \"POST\""));
}

#[test]
fn workflow_iterates_csv_and_supports_goto() {
    let base = echo_server();
    let fs = collection(
        &base,
        &[
            ("data/users.csv", "name,age\nAda,36\nAlan,41\n"),
            ("requests/echo.req.yaml", "name: Echo\nmethod: GET\nurl: '{{baseUrl}}/echo/{{name}}'\n"),
            ("requests/missing.req.yaml", "name: Missing\nmethod: GET\nurl: '{{baseUrl}}/status/404'\n"),
            (
                "runners/users.runner.yaml",
                r#"name: Users
data: data/users.csv
scripts:
  pre: |
    vars.set('seen', []);
  post: |
    fs.write('out/report.csv', csv.stringify(wf.results.map(r => ({it: r.iteration, step: r.step, status: r.status}))));
    test('all iterations ran', () => expect(vars.get('seen')).toEqual(['Ada', 'Alan']));
steps:
  - name: echo
    request: requests/echo.req.yaml
    scripts:
      post: |
        const seen = vars.get('seen'); seen.push(wf.row.name); vars.set('seen', seen);
        test('path has row value', () => expect(res.json().path).toBe('/echo/' + wf.row.name));
        if (wf.row.name === 'Ada') wf.goto('last');
  - name: skipped-for-ada
    request: requests/missing.req.yaml
    if: wf.row.name !== 'Alan'
  - name: last
    request: requests/missing.req.yaml
    scripts:
      post: |
        test('404', () => expect(res.status).toBe(404));
"#,
            ),
        ],
    );
    let out = run(fs, Target::Workflow("runners/users.runner.yaml".into()), opts());
    let w = out.workflow.unwrap();
    assert!(w.error.is_none() && w.script_errors.is_empty(), "{:?} {:?}", w.error, w.script_errors);
    assert_eq!(w.iterations.len(), 2);
    let steps0: Vec<_> = w.iterations[0].steps.iter().map(|s| s.step.as_str()).collect();
    assert_eq!(steps0, vec!["echo", "last"]);
    let steps1: Vec<_> = w.iterations[1].steps.iter().map(|s| (s.step.as_str(), s.skipped)).collect();
    assert_eq!(steps1, vec![("echo", false), ("skipped-for-ada", true), ("last", false)]);
    assert_eq!(w.failed, 0, "{:#?}", w);
    assert_eq!(w.passed, 5);
    assert_eq!(out.changed_files["out/report.csv"].as_deref().unwrap(), "it,step,status\n0,echo,200\n0,last,404\n1,echo,200\n1,last,404\n");
}

#[test]
fn script_limits() {
    let base = echo_server();
    let fs = collection(
        &base,
        &[
            ("postbote.yaml", "name: T\nsettings:\n  scriptTimeoutMs: 300\n"),
            ("requests/loop.req.yaml", "name: L\nurl: http://x\nscripts:\n  pre: 'while (true) {}'\n"),
            ("requests/mem.req.yaml", "name: M\nurl: http://x\nscripts:\n  pre: 'let a = []; while (true) a.push(new Array(1e6).fill(1));'\n"),
            ("requests/syntax.req.yaml", "name: S\nurl: http://x\nscripts:\n  pre: 'let = ;'\n"),
        ],
    );
    let files = fs.list().unwrap();
    let mk = || -> Box<dyn Fs> { Box::new(MemFs::new(files.clone()).unwrap()) };

    let start = std::time::Instant::now();
    let r = run(mk(), Target::Request("requests/loop.req.yaml".into()), opts()).request.unwrap();
    assert!(r.script_errors[0].contains("script timeout"), "{:?}", r.script_errors);
    assert!(start.elapsed() < Duration::from_secs(3));

    let o = RunOptions { memory_limit: 32 << 20, ..opts() };
    let r = run(mk(), Target::Request("requests/mem.req.yaml".into()), o).request.unwrap();
    assert!(!r.script_errors.is_empty() && r.response.is_none(), "{:?}", r);

    let r = run(mk(), Target::Request("requests/syntax.req.yaml".into()), opts()).request.unwrap();
    assert!(r.script_errors[0].contains("SyntaxError"), "{:?}", r.script_errors);
}

#[test]
fn node_workflow_runs_nodes_loops_switches_and_subworkflows() {
    let base = echo_server();
    let graph = r#"name: Onboard
nodes:
  - { id: start, type: manual, payload: '{"ids": [1, 2, 3], "color": "red", "region": "evil"}' }
  - id: prep
    type: script
    input: json
    code: "return input.ids.map(id => ({ id, color: 'green', region: 'evil' }))"
  - { id: each, type: forEach, input: json, child: call }
  - { id: call, type: request, input: json, request: requests/item.req.yaml }
  - id: sum
    type: script
    code: "return input.map(r => r.path + '|' + r.headers['x-color'] + '|' + r.headers['x-region'])"
  - id: check
    type: switch
    cases: [{ name: three, expr: "input.length === 3" }]
  - { id: save, type: writeFile, input: json, path: "data/{{input.0}}.json", format: json }
  - { id: csv, type: makeCsv }
  - { id: done, type: return }
  - { id: other, type: return }
edges:
  - { from: start, out: out, to: prep }
  - { from: prep, out: out, to: each }
  - { from: each, out: out, to: sum }
  - { from: sum, out: out, to: check }
  - { from: check, out: three, to: save }
  - { from: check, out: default, to: other }
  - { from: save, out: out, to: done }
"#;
    let fs = collection(
        &base,
        &[
            ("postbote.yaml", &format!("version: 1\nname: T\nvariables:\n  baseUrl: {base}\n  color: blue\n")),
            ("requests/item.req.yaml", "name: Item\nurl: \"{{baseUrl}}/item/{{input.id}}\"\nheaders:\n  - key: X-Color\n    value: \"{{color}}\"\n  - key: X-Region\n    value: \"{{region}}\"\n"),
            ("workflows/onboard.workflow.yaml", graph),
        ],
    );
    let out = run(fs, Target::Graph("workflows/onboard.workflow.yaml".into(), None), opts());
    let g = out.graph.unwrap();
    assert!(g.error.is_none(), "{:?} {:#?}", g.error, g.steps);
    // input fields override collection variables (color) but never the environment (region=eu)
    let expected = serde_json::json!(["/item/1|green|eu", "/item/2|green|eu", "/item/3|green|eu"]);
    assert_eq!(g.result.unwrap(), expected);
    assert_eq!(g.steps.iter().filter(|s| s.kind == "request").count(), 3);
    let written = out.changed_files.get("data//item/1|green|eu.json").or(out.changed_files.values().next());
    assert!(written.is_some(), "{:?}", out.changed_files.keys().collect::<Vec<_>>());
}

#[test]
fn node_workflow_error_ports_and_subworkflows() {
    let base = echo_server();
    let main = r#"nodes:
  - { id: s, type: manual, payload: '{"n": 21}' }
  - { id: sub, type: workflow, workflow: workflows/double.workflow.yaml }
  - { id: bad, type: script, code: "throw new Error('boom')" }
  - { id: catch, type: script, code: "return { caught: input.message }" }
  - { id: ret, type: return }
edges:
  - { from: s, out: out, to: sub }
  - { from: sub, out: out, to: bad }
  - { from: bad, out: err, to: catch }
  - { from: catch, out: out, to: ret }
"#;
    let double = r#"nodes:
  - { id: in, type: fromWorkflow, input: json }
  - { id: x2, type: script, code: "return { n: input.n * 2 }" }
  - { id: r, type: return }
edges:
  - { from: in, out: out, to: x2 }
  - { from: x2, out: out, to: r }
"#;
    let unhandled = "nodes:\n  - { id: s, type: manual }\n  - { id: c, type: request, request: requests/missing.req.yaml }\nedges:\n  - { from: s, out: out, to: c }\n";
    let recursive = "nodes:\n  - { id: s, type: manual, payload: '{}' }\n  - { id: in, type: fromWorkflow }\n  - { id: w, type: workflow, workflow: workflows/loop.workflow.yaml }\nedges:\n  - { from: s, out: out, to: w }\n  - { from: in, out: out, to: w }\n";
    let mk = || {
        collection(
            &base,
            &[
                ("workflows/main.workflow.yaml", main),
                ("workflows/double.workflow.yaml", double),
                ("workflows/unhandled.workflow.yaml", unhandled),
                ("workflows/loop.workflow.yaml", recursive),
            ],
        )
    };
    let g = run(mk(), Target::Graph("workflows/main.workflow.yaml".into(), None), opts()).graph.unwrap();
    assert!(g.error.is_none(), "{:?}", g.error);
    assert_eq!(g.result.unwrap(), serde_json::json!({ "caught": "Error: boom" }));
    assert!(g.steps.iter().any(|s| s.kind == "workflow" && s.output["value"] == serde_json::json!({ "n": 42 })));

    let g = run(mk(), Target::Graph("workflows/unhandled.workflow.yaml".into(), None), opts()).graph.unwrap();
    assert!(g.error.as_deref().unwrap_or("").contains("missing.req.yaml"), "{:?}", g.error);

    let g = run(mk(), Target::Graph("workflows/loop.workflow.yaml".into(), None), opts()).graph.unwrap();
    assert!(g.error.as_deref().unwrap_or("").contains("nested deeper"), "{:?}", g.error);
}

#[test]
fn request_inputs_sample_values_and_workflow_override() {
    let base = echo_server();
    let req = "name: User\nurl: \"{{baseUrl}}/users/{{input.id}}/{{input.org.name}}\"\ninputs:\n  id: \"7\"\n  org.name: acme\n";
    let flow = "nodes:\n  - { id: s, type: manual, payloadType: csv, payload: \"id,org\\n42,x\" }\n  - { id: e, type: forEach, child: c }\n  - { id: c, type: request, request: requests/user.req.yaml }\n  - { id: r, type: return }\nedges:\n  - { from: s, out: out, to: e }\n  - { from: e, out: out, to: r }\n";
    let mk = || collection(&base, &[("requests/user.req.yaml", req), ("workflows/f.workflow.yaml", flow)]);
    // on its own: the sample inputs
    let r = run(mk(), Target::Request("requests/user.req.yaml".into()), opts()).request.unwrap();
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(r.request.unwrap().url.ends_with("/users/7/acme"));
    // from a workflow (CSV start → JSON rows): the node input replaces them (org.name missing → unresolved)
    let g = run(mk(), Target::Graph("workflows/f.workflow.yaml".into(), None), opts()).graph.unwrap();
    let call = g.steps.iter().find(|s| s.kind == "request").unwrap();
    assert!(call.error.as_deref().unwrap_or("").contains("{{input.org.name}}"), "{:?}", call.error);
}

#[test]
fn workflow_utility_nodes_and_parallel_for_each() {
    let base = echo_server();
    let flow = r#"nodes:
  - { id: s, type: manual, payloadType: csv, payload: "id,active\n1,yes\n2,no\n3,yes\n4,yes\n5,yes" }
  - { id: tok, type: setVar, variable: token, value: "t-{{input.0.id}}" }
  - { id: act, type: filter, expr: "item.active === 'yes'" }
  - { id: wait, type: delay, ms: 10 }
  - { id: each, type: forEach, child: call, parallel: true, limit: 4 }
  - { id: call, type: request, request: requests/slow.req.yaml }
  - { id: check, type: assert, checks: [{ expr: "input.length === 4" }, { expr: "input.every(r => r.headers['x-token'] === 't-1')", message: "token header" }] }
  - id: shape
    type: transform
    template: '{ "count": 4, "first": "{{input.0.path}}" }'
  - { id: r, type: return }
edges:
  - { from: s, out: out, to: tok }
  - { from: tok, out: out, to: act }
  - { from: act, out: out, to: wait }
  - { from: wait, out: out, to: each }
  - { from: each, out: out, to: check }
  - { from: check, out: out, to: shape }
  - { from: shape, out: out, to: r }
"#;
    let fail = "nodes:\n  - { id: s, type: manual, payload: '{\"n\": 1}' }\n  - { id: a, type: assert, checks: [{ expr: 'input.n === 2', message: 'n must be 2' }] }\nedges:\n  - { from: s, out: out, to: a }\n";
    let mk = || {
        collection(
            &base,
            &[
                ("requests/slow.req.yaml", "name: Slow\nurl: \"{{baseUrl}}/slow/{{input.id}}\"\nheaders:\n  - key: X-Token\n    value: \"{{token}}\"\n"),
                ("workflows/u.workflow.yaml", flow),
                ("workflows/fail.workflow.yaml", fail),
            ],
        )
    };
    let started = std::time::Instant::now();
    let g = run(mk(), Target::Graph("workflows/u.workflow.yaml".into(), None), opts()).graph.unwrap();
    let took = started.elapsed();
    assert!(g.error.is_none(), "{:?} {:#?}", g.error, g.steps.iter().map(|s| (&s.node, &s.error)).collect::<Vec<_>>());
    assert_eq!(g.result.unwrap(), serde_json::json!({ "count": 4, "first": "/slow/1" }));
    // four 300 ms requests at once, not one after another
    assert!(took < Duration::from_millis(1000), "took {took:?}");
    assert_eq!(g.steps.iter().filter(|s| s.kind == "request").count(), 4);

    let g = run(mk(), Target::Graph("workflows/fail.workflow.yaml".into(), None), opts()).graph.unwrap();
    assert!(g.error.as_deref().unwrap_or("").contains("assertion failed: n must be 2"), "{:?}", g.error);
}

#[test]
fn workflow_request_errors_response_mode_merge_and_csv_files() {
    let base = echo_server();
    let flow = r#"nodes:
  - { id: s, type: manual, payload: '{"id": 1}' }
  - { id: notfound, type: request, request: requests/missing-page.req.yaml }
  - { id: caught, type: script, code: "return input.message" }
  - { id: lenient, type: request, request: requests/missing-page.req.yaml, failOnError: false, output: response }
  - { id: status, type: script, code: "return input.status" }
  - { id: rows, type: loadFile, path: data/users.csv, parse: csv }
  - { id: count, type: script, code: "return input.length" }
  - { id: join, type: merge }
  - { id: r, type: return }
edges:
  - { from: s, out: out, to: notfound }
  - { from: notfound, out: err, to: caught }
  - { from: caught, out: out, to: join }
  - { from: s, out: out, to: lenient }
  - { from: lenient, out: out, to: status }
  - { from: status, out: out, to: join }
  - { from: s, out: out, to: rows }
  - { from: rows, out: out, to: count }
  - { from: count, out: out, to: join }
  - { from: join, out: out, to: r }
"#;
    let fs = collection(
        &base,
        &[
            ("requests/missing-page.req.yaml", "name: Missing\nurl: \"{{baseUrl}}/status/404\"\n"),
            ("data/users.csv", "id,name\n1,ada\n2,grace\n"),
            ("workflows/m.workflow.yaml", flow),
        ],
    );
    let g = run(fs, Target::Graph("workflows/m.workflow.yaml".into(), None), opts()).graph.unwrap();
    assert!(g.error.is_none(), "{:?} {:#?}", g.error, g.steps.iter().map(|s| (&s.node, &s.error)).collect::<Vec<_>>());
    // one merged value after all three branches; 404 went to err by default
    assert_eq!(g.result.unwrap(), serde_json::json!({ "caught": "HTTP 404 Not Found", "status": 404, "count": 2 }));
    assert_eq!(g.steps.iter().filter(|s| s.kind == "merge").count(), 1);
}
