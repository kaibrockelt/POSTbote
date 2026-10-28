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
                let status = if path.starts_with("/status/404") { "404 Not Found" } else { "200 OK" };
                let set_cookie = if path.starts_with("/login") { "Set-Cookie: session=abc; Path=/; HttpOnly\r\n" } else { "" };
                let out = serde_json::json!({
                    "method": method, "path": path, "headers": headers,
                    "body": String::from_utf8_lossy(&body),
                })
                .to_string();
                let mut s = stream;
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\n{set_cookie}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
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
fn cookies_persist_per_environment() {
    let base = echo_server();
    let files = |extra: &[(&str, &str)]| -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        m.insert("postbote.yaml".into(), format!("version: 1\nname: T\nvariables:\n  baseUrl: {base}\n"));
        m.insert(".gitignore".into(), "# >>> POSTBote (managed block, edit via collection settings) >>>\n*.env\n# <<< POSTBote <<<\n".into());
        m.insert("environments/dev.env.pub".into(), "a=1\n".into());
        m.insert("requests/login.req.yaml".into(), "name: Login\nurl: \"{{baseUrl}}/login\"\n".into());
        m.insert(
            "requests/me.req.yaml".into(),
            "name: Me\nurl: \"{{baseUrl}}/me\"\nscripts:\n  post: |\n    vars.set('sent', res.json().headers.cookie || '');\n    vars.set('jar', cookies.get('session') || '');\n    test('cookie', () => expect(res.json().headers.cookie).toBe('session=abc'));\n".into(),
        );
        for (k, v) in extra {
            m.insert(k.to_string(), v.to_string());
        }
        m
    };
    // first run: the server sets a session cookie
    let out = run(Box::new(MemFs::new(files(&[])).unwrap()), Target::Request("requests/login.req.yaml".into()), opts());
    assert!(out.request.unwrap().error.is_none());
    let jar = out.changed_files.get(".cookies/dev.json").cloned().flatten().expect("jar written");
    assert!(jar.contains("session=abc"), "{jar}");
    let ignore = out.changed_files.get(".gitignore").cloned().flatten().expect(".gitignore updated");
    assert!(ignore.contains(".cookies/\n# <<< POSTBote <<<"), "{ignore}");

    // second run with the stored jar: the cookie is sent again
    let fs = MemFs::new(files(&[(".cookies/dev.json", &jar)])).unwrap();
    let r = run(Box::new(fs), Target::Request("requests/me.req.yaml".into()), opts()).request.unwrap();
    assert!(r.tests.iter().all(|t| t.passed), "{:#?} {:?}", r.tests, r.script_errors);

    // other environments (here: none) have their own jar
    let fs = MemFs::new(files(&[(".cookies/dev.json", &jar)])).unwrap();
    let r = run(Box::new(fs), Target::Request("requests/me.req.yaml".into()), RunOptions::default()).request.unwrap();
    assert!(r.tests.iter().any(|t| !t.passed));
}
