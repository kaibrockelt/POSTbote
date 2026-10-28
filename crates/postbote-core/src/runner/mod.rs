//! Executes requests and runners including their script chains.
//!
//! One run = one QuickJS runtime on the calling thread. Scripts talk to the
//! native side through a single `__host(op, argsJson)` function (see
//! `prelude.js` and `host.rs`), which keeps the FFI surface tiny.

mod host;
pub mod http;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use base64::Engine as _;
use regex::Regex;
use rquickjs::{CatchResultExt, Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::dotenv;
use crate::fs::{Fs, Tracking, is_not_found};
use crate::model::{self, Auth, Collection, Step};
use http::{Http, OutBody, OutReq, Part};

pub use host::{parse_csv, stringify_csv, uuid};

const PRELUDE: &str = include_str!("prelude.js");
const MAX_STEP_EXECUTIONS: usize = 10_000;
const WORKFLOW_BODY_LIMIT: usize = 256 * 1024;

// ---------------------------------------------------------------- results

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SentRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub status: u16,
    pub status_text: String,
    pub proto: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// "" (utf-8 text) or "base64"
    #[serde(skip_serializing_if = "String::is_empty")]
    pub encoding: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    pub size: u64,
    pub time_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestResult {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<SentRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<Response>,
    pub tests: Vec<TestResult>,
    pub logs: Vec<LogEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub script_errors: Vec<String>,
    pub duration_ms: u64,
}

impl RequestResult {
    pub fn failed(&self) -> bool {
        self.error.is_some() || !self.script_errors.is_empty() || self.tests.iter().any(|t| !t.passed)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StepResult {
    pub step: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<RequestResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Iteration {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<Value>,
    pub steps: Vec<StepResult>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResult {
    pub name: String,
    pub path: String,
    pub iterations: Vec<Iteration>,
    pub tests: Vec<TestResult>,
    pub logs: Vec<LogEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub script_errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<String>,
    pub passed: usize,
    pub failed: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<WorkflowResult>,
    /// files written by the run (environment updates, fs.write); None = deleted
    pub changed_files: BTreeMap<String, Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RunOutput {
    pub fn failed(&self) -> bool {
        self.error.is_some()
            || self.request.as_ref().is_some_and(|r| r.failed())
            || self.workflow.as_ref().is_some_and(|w| w.error.is_some() || !w.script_errors.is_empty() || w.failed > 0)
    }
}

// ---------------------------------------------------------------- options

#[derive(Debug, Clone)]
pub enum Target {
    Request(String),
    Workflow(String),
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    /// name of the active environment: `environments/<name>.env.pub` (shared)
    /// overlaid by `environments/<name>.env` (private)
    pub env: Option<String>,
    /// block requests to private/loopback networks (team server)
    pub deny_private: bool,
    pub max_duration: Duration,
    pub max_body: usize,
    pub memory_limit: usize,
    pub cancel: Arc<AtomicBool>,
    /// runner rows as text (CSV/TSV with header or a JSON array), used instead
    /// of the runner's data file; `Some("")` means a single iteration
    pub data: Option<String>,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            env: None,
            deny_private: false,
            max_duration: Duration::from_secs(3600),
            max_body: 20 << 20,
            memory_limit: 256 << 20,
            cancel: Arc::new(AtomicBool::new(false)),
            data: None,
        }
    }
}

// ---------------------------------------------------------------- clock

/// Shared with the QuickJS interrupt handler.
struct Clock {
    base: Instant,
    script_deadline: AtomicU64,
    run_deadline: u64,
    cancel: Arc<AtomicBool>,
}

impl Clock {
    fn now(&self) -> u64 {
        self.base.elapsed().as_millis() as u64
    }
    fn arm(&self, timeout_ms: u64) {
        self.script_deadline.store(self.now() + timeout_ms, Ordering::Relaxed);
    }
    fn disarm(&self) {
        self.script_deadline.store(u64::MAX, Ordering::Relaxed);
    }
    fn extend(&self, d: Duration) {
        let _ = self.script_deadline.try_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
            (v != u64::MAX).then(|| v.saturating_add(d.as_millis() as u64))
        });
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || self.now() > self.run_deadline
    }
    fn interrupt(&self) -> bool {
        self.cancelled() || self.now() > self.script_deadline.load(Ordering::Relaxed)
    }
    fn reason(&self) -> &'static str {
        if self.cancel.load(Ordering::Relaxed) {
            "run cancelled"
        } else if self.now() > self.run_deadline {
            "maximum run duration exceeded"
        } else {
            "script timeout"
        }
    }
}

// ---------------------------------------------------------------- state

struct State {
    fs: Tracking<Box<dyn Fs>>,
    col: Collection,
    env_name: Option<String>,
    env_path: Option<String>,
    env: BTreeMap<String, String>,
    env_order: Vec<String>,
    env_changes: BTreeMap<String, Option<String>>,
    vars: Map<String, Value>,
    row: Option<Value>,
    /// collection + folder variables of the request being executed
    scope_vars: BTreeMap<String, String>,
    tests: Vec<TestResult>,
    logs: Vec<LogEntry>,
    source: String,
    slots: HashMap<String, String>,
    http: Http,
    clock: Arc<Clock>,
}

fn var_text(v: &Value) -> String {
    host::value_to_text(v)
}

impl State {
    fn log(&mut self, level: &str, message: String) {
        self.logs.push(LogEntry { level: level.into(), message, source: self.source.clone() });
    }

    /// Variable lookup: runtime vars > data row > environment > folder/collection vars.
    fn lookup(&self, name: &str) -> Option<String> {
        self.lookup_src(name).map(|(v, _)| v)
    }

    /// The value and whether it comes from configuration (environment, folder,
    /// collection). Only those may contain further `{{placeholders}}`: values
    /// from responses or data rows are never re-interpolated, so an API cannot
    /// make the runner insert e.g. `{{token}}` into a later request.
    fn lookup_src(&self, name: &str) -> Option<(String, bool)> {
        if let Some(v) = self.vars.get(name) {
            return Some((var_text(v), false));
        }
        if let Some(Value::Object(row)) = &self.row {
            if let Some(v) = row.get(name) {
                return Some((var_text(v), false));
            }
        }
        if let Some(v) = self.env.get(name) {
            return Some((v.clone(), true));
        }
        if let Some(v) = self.scope_vars.get(name) {
            return Some((v.clone(), true));
        }
        self.builtin(name).map(|v| (v, false))
    }

    fn builtin(&self, name: &str) -> Option<String> {
        match name {
            "$uuid" | "$guid" => Some(uuid()),
            "$timestamp" => Some(time::OffsetDateTime::now_utc().unix_timestamp().to_string()),
            "$timestampMs" => Some((time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).to_string()),
            "$isoTimestamp" => time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).ok(),
            "$randomInt" => Some((rand::random::<u32>() % 1000).to_string()),
            _ => None,
        }
    }

    /// Replaces `{{name}}` placeholders; unknown names are left untouched.
    /// Configured values may reference other variables (e.g.
    /// `baseUrl=https://{{region}}.api.test`), resolved up to a few levels deep.
    fn interp(&self, s: &str) -> String {
        self.interp_depth(s, 0)
    }

    fn interp_depth(&self, s: &str, depth: usize) -> String {
        static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").unwrap());
        if !s.contains("{{") {
            return s.to_string();
        }
        re.replace_all(s, |c: &regex::Captures| match self.lookup_src(&c[1]) {
            Some((v, true)) if depth < 4 && v.contains("{{") => self.interp_depth(&v, depth + 1),
            Some((v, _)) => v,
            None => c[0].to_string(),
        })
        .into_owned()
    }
}

// ---------------------------------------------------------------- engine

struct Engine {
    // field order matters: the context must be dropped before the runtime
    ctx: Context,
    _rt: Runtime,
    st: Rc<RefCell<State>>,
    clock: Arc<Clock>,
    script_timeout: u64,
    data: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedReq {
    method: String,
    url: String,
    body: String,
    body_type: String,
    headers: Vec<(String, String)>,
    params: Vec<ExportedKv>,
    fields: Vec<ExportedKv>,
}

#[derive(Deserialize)]
struct ExportedKv {
    key: String,
    value: String,
    #[serde(default)]
    file: String,
}

#[derive(Deserialize, Default)]
struct Ctl {
    #[serde(default)]
    next: String,
    #[serde(default)]
    stop: String,
    #[serde(default)]
    skip: bool,
}

impl Engine {
    fn new(fs: Box<dyn Fs>, opts: &RunOptions) -> anyhow::Result<Self> {
        let col = model::load_collection(&*fs)?;
        let clock = Arc::new(Clock {
            base: Instant::now(),
            script_deadline: AtomicU64::new(u64::MAX),
            run_deadline: opts.max_duration.as_millis() as u64,
            cancel: opts.cancel.clone(),
        });

        // shared values first, private values on top; env.set() writes to the private file
        let (mut env, mut env_order, mut env_path) = (BTreeMap::new(), Vec::new(), None);
        if let Some(name) = &opts.env {
            model::check_env_name(name)?;
            let read = |p: &str| match fs.read(p) {
                Ok(text) => Ok(Some(text)),
                Err(e) if is_not_found(&e) => Ok(None),
                Err(e) => Err(e),
            };
            if let Some(text) = read(&model::env_public_path(name))? {
                env.extend(dotenv::parse(&text).0);
            }
            let private = model::env_private_path(name);
            if let Some(text) = read(&private)? {
                let (vals, order) = dotenv::parse(&text);
                for (k, v) in vals {
                    // an empty private value means "not set" and keeps the shared one
                    if v.is_empty() && env.get(&k).is_some_and(|s| !s.is_empty()) {
                        continue;
                    }
                    env.insert(k, v);
                }
                env_order = order;
            }
            env_path = Some(private);
        }
        let env_name = opts.env.clone();

        let http = Http::new(&col.settings, opts.deny_private, opts.max_body)?;
        let script_timeout = col.settings.script_timeout_ms();
        let st = Rc::new(RefCell::new(State {
            fs: Tracking::new(fs),
            col,
            env_name,
            env_path,
            env,
            env_order,
            env_changes: BTreeMap::new(),
            vars: Map::new(),
            row: None,
            scope_vars: BTreeMap::new(),
            tests: Vec::new(),
            logs: Vec::new(),
            source: String::new(),
            slots: HashMap::new(),
            http,
            clock: clock.clone(),
        }));

        let rt = Runtime::new()?;
        rt.set_memory_limit(opts.memory_limit);
        rt.set_max_stack_size(1 << 20);
        let ic = clock.clone();
        rt.set_interrupt_handler(Some(Box::new(move || ic.interrupt())));
        let ctx = Context::full(&rt)?;

        let hs = st.clone();
        ctx.with(|ctx| -> anyhow::Result<()> {
            let f = Function::new(ctx.clone(), move |op: String, args: String| -> String {
                let args: Vec<Value> = serde_json::from_str(&args).unwrap_or_default();
                let res = hs.borrow_mut().host(&op, &args);
                match res {
                    Ok(Some(v)) => json!({ "v": v }),
                    Ok(None) => json!({ "u": 1 }),
                    Err(e) => json!({ "e": e }),
                }
                .to_string()
            })?;
            ctx.globals().set("__host", f)?;
            ctx.eval::<(), _>(PRELUDE).catch(&ctx).map_err(|e| anyhow::anyhow!("prelude: {e}"))?;
            Ok(())
        })?;

        Ok(Self { ctx, _rt: rt, st, clock, script_timeout, data: opts.data.clone() })
    }

    fn slot(&self, name: &str, value: String) {
        self.st.borrow_mut().slots.insert(name.into(), value);
    }

    /// Evaluates internal glue code (not user code) returning a string.
    /// The error is replaced by the interrupt reason when the deadline passed.
    fn eval<T: for<'js> rquickjs::FromJs<'js>>(&self, code: &str) -> Result<T, String> {
        self.clock.arm(self.script_timeout);
        let r = self.ctx.with(|ctx| ctx.eval::<T, _>(code).catch(&ctx).map_err(|e| e.to_string()));
        let interrupted = self.clock.interrupt().then(|| self.clock.reason().to_string());
        self.clock.disarm();
        match (r, interrupted) {
            (_, Some(reason)) => Err(reason),
            (r, None) => r,
        }
    }

    fn eval_str(&self, code: &str) -> Result<String, String> {
        self.eval::<String>(code)
    }

    fn eval_unit(&self, code: &str) -> Result<(), String> {
        self.eval::<()>(code)
    }

    fn run_script(&self, code: &str, source: &str) -> Result<(), String> {
        if code.trim().is_empty() {
            return Ok(());
        }
        if self.clock.cancelled() {
            return Err(format!("{source}: {}", self.clock.reason()));
        }
        {
            let mut st = self.st.borrow_mut();
            st.source = source.to_string();
            st.slots.insert("script".into(), code.to_string());
        }
        let r = self.eval_str("__runUser()").map_err(|e| format!("{source}: {e}"))?;
        if r.is_empty() { Ok(()) } else { Err(format!("{source}: {r}")) }
    }

    fn eval_cond(&self, expr: &str, source: &str) -> Result<bool, String> {
        {
            let mut st = self.st.borrow_mut();
            st.source = source.to_string();
            st.slots.insert("script".into(), expr.to_string());
        }
        let r = self.eval_str("__evalCond()")?;
        let v: Value = serde_json::from_str(&r).map_err(|e| e.to_string())?;
        match v.get("e") {
            Some(e) => Err(var_text(e)),
            None => Ok(v.get("v").and_then(Value::as_bool).unwrap_or(false)),
        }
    }

    fn drain(&self) -> (Vec<TestResult>, Vec<LogEntry>) {
        let mut st = self.st.borrow_mut();
        (std::mem::take(&mut st.tests), std::mem::take(&mut st.logs))
    }

    // ------------------------------------------------------------ request

    fn exec_request(&self, path: &str, step: Option<&Step>) -> RequestResult {
        let start = Instant::now();
        let mut res = RequestResult { path: path.to_string(), ..Default::default() };
        self.exec_request_inner(path, step, &mut res);
        let (tests, logs) = self.drain();
        res.tests.extend(tests);
        res.logs.extend(logs);
        res.duration_ms = start.elapsed().as_millis() as u64;
        res
    }

    fn exec_request_inner(&self, path: &str, step: Option<&Step>, res: &mut RequestResult) {
        let loaded = {
            let st = self.st.borrow();
            model::load_request(&st.fs, path).and_then(|r| Ok((r, model::load_folder_chain(&st.fs, path)?)))
        };
        let (req, folders) = match loaded {
            Ok(x) => x,
            Err(e) => {
                res.error = Some(format!("{e:#}"));
                return;
            }
        };
        res.name = if req.name.is_empty() {
            path.rsplit('/').next().unwrap_or(path).trim_end_matches(model::REQUEST_EXT).to_string()
        } else {
            req.name.clone()
        };

        let col = self.st.borrow().col.clone();

        // variables, headers and auth inherit collection -> folders -> request
        let mut scope = col.variables.clone();
        let mut headers: Vec<(String, String)> = Vec::new();
        let mut merge = |kvs: &[model::Kv]| {
            for kv in model::enabled(kvs) {
                match headers.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(&kv.key)) {
                    Some(h) => h.1 = kv.value.clone(),
                    None => headers.push((kv.key.clone(), kv.value.clone())),
                }
            }
        };
        merge(&col.headers);
        for f in &folders {
            scope.extend(f.variables.clone());
            merge(&f.headers);
        }
        merge(&req.headers);
        self.st.borrow_mut().scope_vars = scope;
        let auth = resolve_auth(&col, &folders, &req.auth);

        let data = json!({
            "name": res.name,
            "method": if req.method.is_empty() { "GET".to_string() } else { req.method.to_uppercase() },
            "url": req.url,
            // a file body exposes its path to scripts (req.body)
            "body": if req.body.kind == "file" { &req.body.file } else { &req.body.content },
            "bodyType": req.body.kind,
            "headers": headers,
            "params": model::enabled(&req.params).map(|p| json!({"key": p.key, "value": p.value})).collect::<Vec<_>>(),
            "fields": model::enabled(&req.body.fields).map(|p| json!({"key": p.key, "value": p.value, "file": p.file})).collect::<Vec<_>>(),
        });
        self.slot("req", data.to_string());
        if let Err(e) = self.eval_unit("globalThis.req = __makeReq(__slot('req')); globalThis.res = undefined;") {
            res.error = Some(e);
            return;
        }

        let mut pre: Vec<(String, &str)> = vec![("collection pre-request".into(), col.scripts.pre.as_str())];
        for f in &folders {
            pre.push((format!("folder {} pre-request", f.path), f.scripts.pre.as_str()));
        }
        pre.push(("pre-request".into(), req.scripts.pre.as_str()));
        if let Some(s) = step {
            pre.push((format!("step {} pre", s.name), s.scripts.pre.as_str()));
        }
        for (source, code) in pre {
            if let Err(e) = self.run_script(code, &source) {
                res.script_errors.push(e);
                res.error = Some("pre-request script failed, request not sent".into());
                return;
            }
        }

        let exported: ExportedReq = match self
            .eval_str("JSON.stringify(__exportReq(req))")
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        {
            Ok(x) => x,
            Err(e) => {
                res.error = Some(format!("request object: {e}"));
                return;
            }
        };

        let out = match build_request(&self.st.borrow(), exported, auth.as_ref()) {
            Ok(o) => o,
            Err(e) => {
                res.error = Some(e);
                return;
            }
        };
        res.request = Some(SentRequest {
            method: out.method.clone(),
            url: out.url.clone(),
            headers: out.headers.clone(),
            body: match &out.body {
                OutBody::Raw(s) => s.clone(),
                OutBody::Bytes(b) => format!("<{} bytes of binary data>", b.len()),
                OutBody::Form(f) => f.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"),
                OutBody::Multipart(p) => p.iter().map(|p| format!("{}={}", p.name, p.file.as_ref().map(|f| format!("@{}", f.0)).unwrap_or(p.value.clone()))).collect::<Vec<_>>().join("\n"),
                OutBody::None => String::new(),
            },
        });

        if self.clock.cancelled() {
            res.error = Some(self.clock.reason().into());
            return;
        }
        let sent = {
            let st = self.st.borrow();
            st.http.send(&out)
        };
        let response = match sent {
            Ok(r) => r,
            Err(e) => {
                res.error = Some(e);
                return;
            }
        };
        self.slot("res", serde_json::to_string(&response).unwrap_or_default());
        res.response = Some(response);
        if let Err(e) = self.eval_unit("globalThis.res = __makeRes(__slot('res'));") {
            res.error = Some(e);
            return;
        }

        let mut post: Vec<(String, &str)> = vec![("collection post-response".into(), col.scripts.post.as_str())];
        for f in &folders {
            post.push((format!("folder {} post-response", f.path), f.scripts.post.as_str()));
        }
        post.push(("post-response".into(), req.scripts.post.as_str()));
        if let Some(s) = step {
            post.push((format!("step {} post", s.name), s.scripts.post.as_str()));
        }
        for (source, code) in post {
            if let Err(e) = self.run_script(code, &source) {
                res.script_errors.push(e);
            }
        }
    }

    // ------------------------------------------------------------ workflow

    fn exec_workflow(&self, path: &str) -> WorkflowResult {
        let start = Instant::now();
        let mut wr = WorkflowResult { path: path.to_string(), ..Default::default() };
        self.exec_workflow_inner(path, &mut wr);
        let (tests, logs) = self.drain();
        wr.tests.extend(tests);
        wr.logs.extend(logs);
        let all_tests = wr.tests.iter().chain(
            wr.iterations.iter().flat_map(|i| i.steps.iter()).filter_map(|s| s.result.as_ref()).flat_map(|r| r.tests.iter()),
        );
        for t in all_tests {
            if t.passed { wr.passed += 1 } else { wr.failed += 1 }
        }
        wr.duration_ms = start.elapsed().as_millis() as u64;
        wr
    }

    fn exec_workflow_inner(&self, path: &str, wr: &mut WorkflowResult) {
        let loaded = {
            let st = self.st.borrow();
            model::load_workflow(&st.fs, path).and_then(|wf| {
                let rows = match &self.data {
                    Some(text) => parse_rows("data", text, sniff_format(text))?,
                    None if wf.data.is_empty() => Vec::new(),
                    None => load_rows(&st.fs, &wf.data)?,
                };
                Ok((wf, rows))
            })
        };
        let (wf, rows) = match loaded {
            Ok(x) => x,
            Err(e) => {
                wr.error = Some(format!("{e:#}"));
                return;
            }
        };
        wr.name = if wf.name.is_empty() { path.to_string() } else { wf.name.clone() };

        self.slot("wf", json!({ "name": wr.name, "rows": rows }).to_string());
        if let Err(e) = self.eval_unit("globalThis.wf = __makeWf(__slot('wf'));") {
            wr.error = Some(e);
            return;
        }
        if let Err(e) = self.run_script(&wf.scripts.pre, "runner pre") {
            wr.script_errors.push(e);
            wr.error = Some("pre-run script failed".into());
            return;
        }
        let rows: Vec<Value> = match self
            .eval_str("JSON.stringify(Array.isArray(wf.rows) ? wf.rows : [])")
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        {
            Ok(r) => r,
            Err(e) => {
                wr.error = Some(format!("wf.rows: {e}"));
                return;
            }
        };
        let (tests, logs) = self.drain();
        wr.tests.extend(tests);
        wr.logs.extend(logs);

        let mut n = rows.len().max(1);
        if wf.settings.max_iterations > 0 {
            n = n.min(wf.settings.max_iterations);
        }
        let mut executions = 0usize;
        'outer: for it in 0..n {
            let row = rows.get(it).cloned();
            self.st.borrow_mut().row = row.clone();
            self.slot("row", row.clone().unwrap_or(Value::Null).to_string());
            if let Err(e) = self.eval_unit(&format!("wf.iteration = {it}; wf.row = __slot('row');")) {
                wr.error = Some(e);
                break;
            }
            wr.iterations.push(Iteration { index: it, row, steps: Vec::new() });
            let mut i = 0;
            while i < wf.steps.len() {
                if self.clock.cancelled() {
                    wr.stopped = Some(self.clock.reason().into());
                    break 'outer;
                }
                executions += 1;
                if executions > MAX_STEP_EXECUTIONS {
                    wr.stopped = Some(format!("more than {MAX_STEP_EXECUTIONS} step executions (endless wf.goto loop?)"));
                    break 'outer;
                }
                let step = &wf.steps[i];
                let label = if step.name.is_empty() { format!("step {}", i + 1) } else { step.name.clone() };
                let steps = &mut wr.iterations.last_mut().unwrap().steps;

                if !step.condition.trim().is_empty() {
                    match self.eval_cond(&step.condition, &format!("step {label} if")) {
                        Ok(true) => {}
                        Ok(false) => {
                            steps.push(StepResult { step: label, skipped: true, reason: Some("condition is false".into()), result: None });
                            i += 1;
                            continue;
                        }
                        Err(e) => {
                            steps.push(StepResult { step: label, skipped: true, reason: Some(format!("condition error: {e}")), result: None });
                            i += 1;
                            continue;
                        }
                    }
                }
                if step.request.is_empty() {
                    steps.push(StepResult { step: label, skipped: true, reason: Some("no request configured".into()), result: None });
                    i += 1;
                    continue;
                }

                let mut r = self.exec_request(&step.request, Some(step));
                let failed = r.failed();
                let summary = json!({
                    "iteration": it,
                    "step": label,
                    "status": r.response.as_ref().map(|x| x.status),
                    "passed": !failed,
                    "error": r.error,
                    "timeMs": r.response.as_ref().map(|x| x.time_ms),
                });
                self.slot("summary", summary.to_string());
                let glue = self.eval_unit("wf.results.push(__slot('summary')); if (res !== undefined) wf.last = res;");
                let ctl: Ctl = self.eval_str("__takeCtl()").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
                if let Some(resp) = r.response.as_mut() {
                    if resp.body.len() > WORKFLOW_BODY_LIMIT {
                        let mut cut = WORKFLOW_BODY_LIMIT;
                        while !resp.body.is_char_boundary(cut) {
                            cut -= 1;
                        }
                        resp.body.truncate(cut);
                        resp.truncated = true;
                    }
                }
                let steps = &mut wr.iterations.last_mut().unwrap().steps;
                steps.push(StepResult { step: label.clone(), skipped: false, reason: None, result: Some(r) });
                if let Err(e) = glue {
                    wr.error = Some(e);
                    break 'outer;
                }

                if !ctl.stop.is_empty() {
                    wr.stopped = Some(ctl.stop);
                    break 'outer;
                }
                if ctl.skip {
                    break;
                }
                if wf.settings.stop_on_failure && failed {
                    wr.stopped = Some(format!("step '{label}' failed (stopOnFailure)"));
                    break 'outer;
                }
                if wf.settings.delay_ms > 0 {
                    self.st.borrow().sleep(Duration::from_millis(wf.settings.delay_ms));
                }
                if !ctl.next.is_empty() {
                    match wf.steps.iter().position(|s| s.name == ctl.next) {
                        Some(j) => {
                            i = j;
                            continue;
                        }
                        None => {
                            wr.stopped = Some(format!("wf.goto: unknown step {:?}", ctl.next));
                            break 'outer;
                        }
                    }
                }
                i += 1;
            }
        }
        self.st.borrow_mut().row = None;

        if !self.clock.cancelled() {
            if let Err(e) = self.run_script(&wf.scripts.post, "runner post") {
                wr.script_errors.push(e);
            }
        }
    }

    /// Writes pending env.set() changes and returns all files changed by the run.
    fn finish(&self) -> Result<BTreeMap<String, Option<String>>, String> {
        let mut st = self.st.borrow_mut();
        if let Some(p) = st.env_path.clone() {
            if !st.env_changes.is_empty() {
                let old = match st.fs.read(&p) {
                    Ok(s) => s,
                    Err(e) if is_not_found(&e) => String::new(),
                    Err(e) => return Err(format!("{e:#}")),
                };
                let text = dotenv::update(&old, &st.env_changes, &st.env_order);
                st.fs.write(&p, &text).map_err(|e| format!("{e:#}"))?;
            }
        }
        Ok(std::mem::take(&mut st.fs.changes))
    }
}

fn resolve_auth(col: &Collection, folders: &[model::Folder], req: &Option<Auth>) -> Option<Auth> {
    let explicit = |a: &Option<Auth>| a.clone().filter(|a| !a.kind.is_empty() && a.kind != "inherit");
    let found = explicit(req)
        .or_else(|| folders.iter().rev().find_map(|f| explicit(&f.auth)))
        .or_else(|| explicit(&col.auth));
    found.filter(|a| a.kind != "none")
}

fn load_rows(fs: &dyn Fs, path: &str) -> anyhow::Result<Vec<Value>> {
    anyhow::ensure!(path.starts_with("data/"), "{path}: runner data must live in the data/ folder");
    let text = fs.read(path)?;
    let format = if path.ends_with(".tsv") {
        DataFormat::Tsv
    } else if path.ends_with(".csv") {
        DataFormat::Csv
    } else {
        DataFormat::Json
    };
    parse_rows(path, &text, format)
}

#[derive(Clone, Copy)]
enum DataFormat {
    Csv,
    Tsv,
    Json,
}

/// Format of pasted data: a JSON array, TSV when the header has tabs but no commas, else CSV.
fn sniff_format(text: &str) -> DataFormat {
    let t = text.trim_start();
    let header = t.lines().next().unwrap_or("");
    if t.starts_with('[') {
        DataFormat::Json
    } else if header.contains('\t') && !header.contains(',') {
        DataFormat::Tsv
    } else {
        DataFormat::Csv
    }
}

fn parse_rows(name: &str, text: &str, format: DataFormat) -> anyhow::Result<Vec<Value>> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let opts = match format {
        DataFormat::Json => {
            return match serde_json::from_str::<Value>(text).map_err(|e| anyhow::anyhow!("{name}: invalid JSON: {e}"))? {
                Value::Array(a) => Ok(a),
                _ => anyhow::bail!("{name}: runner data must be a CSV table or a JSON array"),
            };
        }
        DataFormat::Tsv => json!({"delimiter": "\t"}),
        DataFormat::Csv => json!({}),
    };
    let v = parse_csv(text, &opts).map_err(|e| anyhow::anyhow!("{name}: {e}"))?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

fn has_header(h: &[(String, String)], name: &str) -> bool {
    h.iter().any(|(k, _)| k.eq_ignore_ascii_case(name))
}

fn build_request(st: &State, x: ExportedReq, auth: Option<&Auth>) -> Result<OutReq, String> {
    let method = Some(st.interp(&x.method).trim().to_uppercase()).filter(|m| !m.is_empty()).unwrap_or_else(|| "GET".into());
    let mut raw_url = st.interp(x.url.trim());
    if raw_url.is_empty() {
        return Err("URL is empty".into());
    }
    if let Some(unresolved) = raw_url.find("{{") {
        let end = raw_url[unresolved..].find("}}").map(|e| unresolved + e + 2).unwrap_or(raw_url.len());
        return Err(format!("unresolved variable {} in URL", &raw_url[unresolved..end]));
    }
    if !raw_url.contains("://") {
        raw_url = format!("http://{raw_url}");
    }
    let mut url = url::Url::parse(&raw_url).map_err(|e| format!("invalid URL {raw_url:?}: {e}"))?;
    let params: Vec<(String, String)> = x.params.iter().filter(|p| !p.key.is_empty()).map(|p| (st.interp(&p.key), st.interp(&p.value))).collect();
    let mut headers: Vec<(String, String)> = x.headers.iter().map(|(k, v)| (st.interp(k), st.interp(v))).collect();

    let mut extra_query = Vec::new();
    if let Some(a) = auth {
        match a.kind.as_str() {
            "bearer" if !has_header(&headers, "authorization") => {
                headers.push(("Authorization".into(), format!("Bearer {}", st.interp(&a.token))));
            }
            "basic" if !has_header(&headers, "authorization") => {
                let cred = format!("{}:{}", st.interp(&a.username), st.interp(&a.password));
                headers.push(("Authorization".into(), format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(cred))));
            }
            "apikey" => {
                let (k, v) = (st.interp(&a.key), st.interp(&a.value));
                if a.location == "query" {
                    extra_query.push((k, v));
                } else if !k.is_empty() && !has_header(&headers, &k) {
                    headers.push((k, v));
                }
            }
            _ => {}
        }
    }
    if !params.is_empty() || !extra_query.is_empty() {
        let mut q = url.query_pairs_mut();
        for (k, v) in params.iter().chain(extra_query.iter()) {
            q.append_pair(k, v);
        }
    }

    let kind = x.body_type.as_str();
    let body = match kind {
        "none" => OutBody::None,
        "form" => OutBody::Form(x.fields.iter().filter(|f| !f.key.is_empty()).map(|f| (st.interp(&f.key), st.interp(&f.value))).collect()),
        "multipart" => {
            let mut parts = Vec::new();
            for f in x.fields.iter().filter(|f| !f.key.is_empty()) {
                let file = if f.file.is_empty() {
                    None
                } else {
                    let p = st.interp(&f.file);
                    let content = st.fs.read_bytes(&p).map_err(|e| format!("multipart field {}: {e:#}", f.key))?;
                    Some((p.rsplit('/').next().unwrap_or(&p).to_string(), content))
                };
                parts.push(Part { name: st.interp(&f.key), value: st.interp(&f.value), file });
            }
            OutBody::Multipart(parts)
        }
        "file" => {
            let p = st.interp(&x.body);
            if p.trim().is_empty() {
                return Err("body type file: choose a file of the collection".into());
            }
            let bytes = st.fs.read_bytes(&p).map_err(|e| format!("body file: {e:#}"))?;
            if !has_header(&headers, "content-type") {
                headers.push(("Content-Type".into(), mime_of(&p).into()));
            }
            OutBody::Bytes(bytes)
        }
        _ if x.body.is_empty() => OutBody::None,
        _ => {
            let ct = match kind {
                "json" => Some("application/json"),
                "xml" => Some("application/xml"),
                "text" => Some("text/plain; charset=utf-8"),
                _ => None,
            };
            if let Some(ct) = ct {
                if !has_header(&headers, "content-type") {
                    headers.push(("Content-Type".into(), ct.into()));
                }
            }
            OutBody::Raw(st.interp(&x.body))
        }
    };
    Ok(OutReq { method, url: url.to_string(), headers, body })
}

/// Content type for a body file by its extension (the header can override it).
fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" | "csv" => "text/plain; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Executes a request or runner of the collection in `fs`.
/// Blocking: call it from a dedicated thread (e.g. `spawn_blocking`).
pub fn run(fs: Box<dyn Fs>, target: Target, opts: RunOptions) -> RunOutput {
    let engine = match Engine::new(fs, &opts) {
        Ok(e) => e,
        Err(e) => return RunOutput { error: Some(format!("{e:#}")), ..Default::default() },
    };
    let mut out = RunOutput::default();
    match &target {
        Target::Request(p) => out.request = Some(engine.exec_request(p, None)),
        Target::Workflow(p) => out.workflow = Some(engine.exec_workflow(p)),
    }
    match engine.finish() {
        Ok(changes) => out.changed_files = changes,
        Err(e) => out.error = Some(format!("saving environment: {e}")),
    }
    out
}

#[cfg(test)]
mod data_tests {
    use super::*;

    fn rows(text: &str) -> anyhow::Result<Vec<Value>> {
        parse_rows("data", text, sniff_format(text))
    }

    #[test]
    fn pasted_data_formats() {
        assert_eq!(rows("name,age\nada,36\n").unwrap(), vec![json!({"name": "ada", "age": "36"})]);
        assert_eq!(rows("name\tage\nada\t36").unwrap(), vec![json!({"name": "ada", "age": "36"})]);
        assert_eq!(rows("  [{\"name\": \"ada\"}, {\"name\": \"grace\"}]").unwrap().len(), 2);
        assert!(rows("").unwrap().is_empty());
        assert!(rows("[{\"name\": ").is_err());
        assert!(rows("[").is_err());
    }
}
