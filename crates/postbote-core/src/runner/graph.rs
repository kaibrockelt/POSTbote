//! Node-based workflows: values flow from a starter node along edges. Every
//! node gets one input and emits on an output port (`out`, `err`, a switch case
//! or `default`); all edges leaving that port are followed in order. An error
//! on a node whose `err` port is not connected stops the workflow.

use std::collections::BTreeMap;
use std::time::Instant;

use base64::Engine as _;
use serde::Serialize;
use serde_json::{Value, json};

use super::host::{parse_csv, stringify_csv};
use super::{Engine, LogEntry, RequestResult, var_text};
use crate::fs::Fs;
use crate::model::{self, Graph, GraphNode};

/// Workflows calling workflows: deeper chains are almost certainly recursion.
const MAX_DEPTH: usize = 8;
/// Node executions per workflow run (loops through edges or switch cases).
const MAX_STEPS: usize = 10_000;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphResult {
    pub name: String,
    pub path: String,
    /// value given to a Return node (or the last output)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub steps: Vec<StepResult>,
    pub logs: Vec<LogEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub node: String,
    pub kind: String,
    pub name: String,
    /// output port taken (`out`, `err`, case name, …)
    pub port: String,
    /// type and value that left the node (shortened for the UI)
    pub output: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestResult>,
    pub duration_ms: u64,
}

/// A value travelling along an edge.
#[derive(Debug, Clone)]
struct Data {
    /// json | csv | text | file | none
    kind: &'static str,
    value: Value,
}

impl Data {
    fn none() -> Self {
        Data { kind: "none", value: Value::Null }
    }
    fn json(v: Value) -> Self {
        Data { kind: "json", value: v }
    }
    fn text(s: String) -> Self {
        Data { kind: "text", value: Value::String(s) }
    }
    fn as_text(&self) -> String {
        match &self.value {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            v => v.to_string(),
        }
    }
    /// Shortened copy for the step list.
    fn preview(&self) -> Value {
        let mut v = self.value.clone();
        if self.kind == "file" {
            if let Some(o) = v.as_object_mut() {
                o.remove("base64");
            }
        }
        let text = v.to_string();
        if text.len() > 20_000 {
            v = Value::String(format!("{}… ({} bytes)", &text[..text.floor_char_boundary(20_000)], text.len()));
        }
        json!({ "type": self.kind, "value": v })
    }
}

/// What happens after a node ran.
enum Emit {
    Port(String, Data),
    Return(Data),
}

struct Run<'a> {
    graph: &'a Graph,
    path: &'a str,
    depth: usize,
    steps: Vec<StepResult>,
    count: usize,
    last: Option<Data>,
    /// merge node → values received so far, by source node
    merges: BTreeMap<String, BTreeMap<String, Value>>,
}

impl Engine {
    pub(super) fn exec_graph(&self, path: &str, starter: Option<&str>, input: Option<Value>, depth: usize) -> GraphResult {
        let start = Instant::now();
        let mut out = GraphResult { path: path.to_string(), ..Default::default() };
        let graph = match model::load_graph(&self.st.borrow().fs, path) {
            Ok(g) => g,
            Err(e) => {
                out.error = Some(format!("{e:#}"));
                return out;
            }
        };
        out.name = if graph.name.is_empty() { path.to_string() } else { graph.name.clone() };

        // called by another workflow: its FromWorkflow starter; else the chosen or first manual starter
        let entry = match (starter, input.is_some()) {
            (Some(id), _) => graph.nodes.iter().find(|n| n.id == id),
            (None, true) => graph.nodes.iter().find(|n| n.kind == "fromWorkflow"),
            (None, false) => graph.nodes.iter().find(|n| n.kind == "manual"),
        };
        let Some(entry) = entry else {
            out.error = Some(match (starter, input.is_some()) {
                (Some(id), _) => format!("starter node {id:?} not found"),
                (None, true) => "this workflow has no FromWorkflow starter, so other workflows cannot call it".into(),
                (None, false) => "this workflow has no Manual starter".into(),
            });
            return out;
        };

        let mut run = Run { graph: &graph, path, depth, steps: Vec::new(), count: 0, last: None, merges: BTreeMap::new() };
        let first = input.map(Data::json).unwrap_or_else(Data::none);
        match self.visit(&mut run, entry, first, None) {
            Ok(Some(ret)) => out.result = Some(ret.value),
            Ok(None) => out.result = run.last.map(|d| d.value),
            Err(e) => out.error = Some(e),
        }
        out.steps = run.steps;
        out.logs = self.drain().1;
        out.duration_ms = start.elapsed().as_millis() as u64;
        out
    }

    /// Runs a node and follows the edges of the port it emitted on.
    /// `Ok(Some)` = a Return node finished the workflow.
    fn visit(&self, run: &mut Run, node: &GraphNode, input: Data, from: Option<&str>) -> Result<Option<Data>, String> {
        run.count += 1;
        if run.count > MAX_STEPS {
            return Err(format!("stopped after {MAX_STEPS} node executions (endless loop?)"));
        }
        if self.clock.cancelled() {
            return Err(self.clock.reason().into());
        }
        let started = Instant::now();
        let mut step = StepResult { node: node.id.clone(), kind: node.kind.clone(), name: node.name.clone(), ..Default::default() };
        let emit = if node.kind == "merge" {
            // waits until every connected source delivered, then continues once
            match merge_input(run, node, from, input) {
                Some(d) => Ok(Emit::Port("out".into(), d)),
                None => return Ok(None),
            }
        } else {
            match check_input(node, input) {
                Ok(data) => self.exec_node(run, node, data, &mut step),
                Err(e) => Err(e),
            }
        };
        step.duration_ms = started.elapsed().as_millis() as u64;
        let (port, data) = match emit {
            Ok(Emit::Return(d)) => {
                step.port = "return".into();
                step.output = d.preview();
                run.steps.push(step);
                return Ok(Some(d));
            }
            Ok(Emit::Port(p, d)) => (p, d),
            Err(e) => {
                step.error = Some(e.clone());
                // the value flowing on gets the message; the step keeps the full text (stack)
                ("err".to_string(), Data::json(json!({ "message": e.lines().next().unwrap_or(""), "node": node.id })))
            }
        };
        step.port = port.clone();
        step.output = data.preview();
        let failed = step.error.clone();
        run.steps.push(step);
        run.last = Some(data.clone());

        let next: Vec<&GraphNode> = run
            .graph
            .edges
            .iter()
            .filter(|e| e.from == node.id && e.out == port)
            .filter_map(|e| run.graph.nodes.iter().find(|n| n.id == e.to))
            .collect();
        if next.is_empty() {
            if let Some(e) = failed {
                return Err(format!("{}: {e}", label(node)));
            }
        }
        for n in next {
            if let Some(ret) = self.visit(run, n, data.clone(), Some(&node.id))? {
                return Ok(Some(ret));
            }
        }
        Ok(None)
    }

    fn exec_node(&self, run: &mut Run, node: &GraphNode, input: Data, step: &mut StepResult) -> Result<Emit, String> {
        let cfg = &node.cfg;
        let s = |k: &str| cfg.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let out = |d: Data| Ok(Emit::Port("out".into(), d));
        match node.kind.as_str() {
            "manual" => {
                let payload = s("payload");
                if payload.trim().is_empty() {
                    return out(Data::none());
                }
                match s("payloadType").as_str() {
                    "text" => out(Data::text(payload)),
                    // CSV with a header row: the rows become JSON objects (ready for forEach)
                    "csv" => parse_csv(&payload, &json!({})).map(Data::json).and_then(out),
                    _ => serde_json::from_str(&payload).map(|v| Data::json(v)).map_err(|e| format!("payload is not valid JSON: {e}")).and_then(out),
                }
            }
            "fromWorkflow" => out(input),
            "request" => {
                let req = s("request");
                if req.is_empty() {
                    return Err("choose a request".into());
                }
                let use_folder = cfg.get("useFolder").and_then(Value::as_bool).unwrap_or(true);
                self.set_call_input(&input, use_folder);
                let res = self.exec_request(&req, None);
                self.clear_call_input();
                let result = request_output(&res, cfg);
                step.request = Some(res);
                result.and_then(out)
            }
            "script" => self.js(node, "__runCompute()", &s("code"), &input).map(Data::json).and_then(out),
            "switch" => {
                let cases = cfg.get("cases").and_then(Value::as_array).cloned().unwrap_or_default();
                for c in cases {
                    let (name, expr) = (c.get("name").and_then(Value::as_str).unwrap_or(""), c.get("expr").and_then(Value::as_str).unwrap_or(""));
                    if name.is_empty() || expr.trim().is_empty() {
                        continue;
                    }
                    if self.js(node, "__evalCase()", expr, &input)?.as_bool() == Some(true) {
                        return Ok(Emit::Port(name.to_string(), input));
                    }
                }
                Ok(Emit::Port("default".into(), input))
            }
            "setVar" => {
                let name = s("variable");
                if name.trim().is_empty() {
                    return Err("set the variable name".into());
                }
                // empty value template = the whole input
                let tpl = s("value");
                let value = if tpl.is_empty() { input.value.clone() } else { Value::String(self.with_input(&input, |st| st.interp(&tpl))) };
                let mut st = self.st.borrow_mut();
                if s("scope") == "env" {
                    if st.env_path.is_none() {
                        st.log("warn", format!("set variable {name:?}: no environment selected, kept for this run only"));
                    }
                    let text = var_text(&value);
                    if !st.env.contains_key(&name) {
                        st.env_order.push(name.clone());
                    }
                    st.env.insert(name.clone(), text.clone());
                    st.env_changes.insert(name, Some(text));
                } else {
                    st.vars.insert(name, value);
                }
                drop(st);
                out(input)
            }
            "filter" => {
                let expr = s("expr");
                if expr.trim().is_empty() {
                    return Err("set the filter expression".into());
                }
                let items = rows_of(&input)?;
                let code = format!("return input.filter((item, index) => ({expr}\n));");
                self.js(node, "__runCompute()", &code, &Data::json(Value::Array(items))).map(Data::json).and_then(out)
            }
            "assert" => {
                let checks = cfg.get("checks").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut failed = Vec::new();
                for c in checks {
                    let expr = c.get("expr").and_then(Value::as_str).unwrap_or("");
                    if expr.trim().is_empty() {
                        continue;
                    }
                    let ok = self.js(node, "__evalCase()", expr, &input)?.as_bool() == Some(true);
                    if !ok {
                        failed.push(c.get("message").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or(expr).to_string());
                    }
                }
                if failed.is_empty() { out(input) } else { Err(format!("assertion failed: {}", failed.join("; "))) }
            }
            "delay" => {
                let ms = self.with_input(&input, |st| st.interp(&cfg.get("ms").map(var_text).unwrap_or_default())).trim().parse::<u64>().map_err(|_| "delay: milliseconds must be a number")?;
                let until = Instant::now() + std::time::Duration::from_millis(ms.min(600_000));
                while Instant::now() < until {
                    if self.clock.cancelled() {
                        return Err(self.clock.reason().into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20).min(until - Instant::now()));
                }
                out(input)
            }
            "transform" => {
                // a JSON (or text) template with {{input.x}} and other variables
                let text = self.with_input(&input, |st| st.interp(&s("template")));
                out(serde_json::from_str(&text).map(Data::json).unwrap_or_else(|_| Data::text(text)))
            }
            "forEach" => {
                let items = rows_of(&input)?;
                let child_id = s("child");
                let child = run.graph.nodes.iter().find(|n| n.id == child_id).ok_or("choose the node to run for every item")?;
                // parallel: calls are prepared one after another, sent at the same time
                // (up to `limit`), and finished in order
                if cfg.get("parallel").and_then(Value::as_bool).unwrap_or(false) && child.kind == "request" {
                    let limit = cfg.get("limit").and_then(Value::as_u64).unwrap_or(5).clamp(1, 50) as usize;
                    return self.parallel_calls(run, child, items, limit).map(|v| Emit::Port("out".into(), Data::json(Value::Array(v))));
                }
                let mut results = Vec::with_capacity(items.len());
                for (i, item) in items.into_iter().enumerate() {
                    let mut sub = StepResult { node: child.id.clone(), kind: child.kind.clone(), name: format!("{} #{}", label(child), i + 1), ..Default::default() };
                    let started = Instant::now();
                    let emitted = check_input(child, Data::json(item)).and_then(|d| self.exec_node(run, child, d, &mut sub));
                    sub.duration_ms = started.elapsed().as_millis() as u64;
                    match emitted {
                        Ok(Emit::Port(_, d) | Emit::Return(d)) => {
                            sub.port = "out".into();
                            sub.output = d.preview();
                            results.push(d.value);
                            run.steps.push(sub);
                        }
                        Err(e) => {
                            sub.error = Some(e.clone());
                            run.steps.push(sub);
                            return Err(format!("item {}: {e}", i + 1));
                        }
                    }
                }
                out(Data::json(Value::Array(results)))
            }
            "loadFile" => {
                let path = self.with_input(&input, |st| st.interp(&s("path")));
                let fs = &self.st.borrow().fs;
                match s("parse").as_str() {
                    "json" => {
                        let t = fs.read(&path).map_err(|e| format!("{e:#}"))?;
                        serde_json::from_str(&t).map(Data::json).map_err(|e| format!("{path}: invalid JSON: {e}")).and_then(out)
                    }
                    // like the CSV start payload: rows with a header become JSON objects
                    "csv" => parse_csv(&fs.read(&path).map_err(|e| format!("{e:#}"))?, &json!({})).map(Data::json).and_then(out),
                    "file" => {
                        // text-safe for now; binary-safe with Fs::read_bytes (feature/binary-body)
                        let bytes = fs.read(&path).map_err(|e| format!("{e:#}"))?.into_bytes();
                        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
                        out(Data { kind: "file", value: json!({ "name": name, "size": bytes.len(), "base64": base64::engine::general_purpose::STANDARD.encode(&bytes) }) })
                    }
                    _ => out(Data::text(fs.read(&path).map_err(|e| format!("{e:#}"))?)),
                }
            }
            "writeFile" => {
                let path = self.with_input(&input, |st| st.interp(&s("path")));
                if path.trim().is_empty() {
                    return Err("set the file path".into());
                }
                let text = match (s("format").as_str(), input.kind) {
                    ("csv", "json") => stringify_csv(&input.value, &json!({}))?,
                    ("csv", _) => input.as_text(),
                    (_, "json") => serde_json::to_string_pretty(&input.value).unwrap_or_default() + "\n",
                    _ => return Err("write file stores JSON or CSV input".into()),
                };
                self.st.borrow_mut().fs.write(&path, &text).map_err(|e| format!("{e:#}"))?;
                out(input)
            }
            "makeCsv" => match &input.value {
                Value::Array(_) => out(Data { kind: "csv", value: Value::String(stringify_csv(&input.value, &json!({}))?) }),
                _ => Err("make CSV needs a JSON array".into()),
            },
            "workflow" => {
                let target = s("workflow");
                if target.is_empty() {
                    return Err("choose a workflow".into());
                }
                if run.depth + 1 >= MAX_DEPTH {
                    return Err(format!("workflows nested deeper than {MAX_DEPTH} levels (recursion?)"));
                }
                let sub = self.exec_graph(&target, None, Some(input.value), run.depth + 1);
                if let Some(e) = sub.error {
                    return Err(format!("{target}: {e}"));
                }
                out(Data::json(sub.result.unwrap_or(Value::Null)))
            }
            "return" => Ok(Emit::Return(input)),
            other => Err(format!("unknown node type {other:?} (in {})", run.path)),
        }
    }

    /// forEach (parallel) with a Call node: batches of `limit` requests.
    fn parallel_calls(&self, run: &mut Run, child: &GraphNode, items: Vec<Value>, limit: usize) -> Result<Vec<Value>, String> {
        let req = child.cfg.get("request").and_then(Value::as_str).unwrap_or("").to_string();
        if req.is_empty() {
            return Err(format!("{}: choose a request", label(child)));
        }
        let use_folder = child.cfg.get("useFolder").and_then(Value::as_bool).unwrap_or(true);
        let mut results = Vec::with_capacity(items.len());
        for (batch_no, batch) in items.chunks(limit).enumerate() {
            // 1. prepare (scripts, variables) one after another
            let mut prepared = Vec::with_capacity(batch.len());
            for item in batch {
                let data = check_input(child, Data::json(item.clone()))?;
                let started = Instant::now();
                let mut res = RequestResult { path: req.clone(), ..Default::default() };
                self.set_call_input(&data, use_folder);
                let p = self.prepare_request(&req, None, &mut res);
                self.clear_call_input();
                prepared.push((res, p, started));
            }
            if self.clock.cancelled() {
                return Err(self.clock.reason().into());
            }
            // 2. send at the same time (the HTTP client is thread-safe; scripts are not involved)
            let http = self.st.borrow().http.clone();
            let sent: Vec<Option<Result<super::Response, String>>> = std::thread::scope(|scope| {
                let handles: Vec<_> = prepared.iter().map(|(_, p, _)| p.as_ref().map(|p| scope.spawn(|| http.send(&p.out)))).collect();
                handles.into_iter().map(|h| h.map(|h| h.join().unwrap_or_else(|_| Err("request thread panicked".into())))).collect()
            });
            // 3. finish in order (post-response scripts, tests)
            for (i, ((mut res, p, started), sent)) in prepared.into_iter().zip(sent).enumerate() {
                if let (Some(p), Some(sent)) = (p, sent) {
                    self.finish_request(p, sent, &mut res);
                }
                let (tests, logs) = self.drain();
                res.tests.extend(tests);
                res.logs.extend(logs);
                res.duration_ms = started.elapsed().as_millis() as u64;
                let n = batch_no * limit + i + 1;
                let mut step = StepResult { node: child.id.clone(), kind: child.kind.clone(), name: format!("{} #{n}", label(child)), port: "out".into(), ..Default::default() };
                let result = request_output(&res, &child.cfg);
                step.duration_ms = res.duration_ms;
                step.request = Some(res);
                let data = match result {
                    Ok(d) => d,
                    Err(e) => {
                        step.error = Some(e.clone());
                        run.steps.push(step);
                        return Err(format!("item {n}: {e}"));
                    }
                };
                step.output = data.preview();
                run.steps.push(step);
                results.push(data.value);
            }
        }
        Ok(results)
    }

    fn set_call_input(&self, input: &Data, use_folder: bool) {
        let mut st = self.st.borrow_mut();
        st.graph_input = Some(input.value.clone());
        // JSON fields override folder/collection variables, never the environment
        st.input_vars = match &input.value {
            Value::Object(o) if input.kind == "json" => o.iter().map(|(k, v)| (k.clone(), var_text(v))).collect(),
            _ => BTreeMap::new(),
        };
        st.skip_folders = !use_folder;
    }

    fn clear_call_input(&self) {
        let mut st = self.st.borrow_mut();
        st.graph_input = None;
        st.input_vars.clear();
        st.skip_folders = false;
    }

    /// Runs compute code / a switch case with `input` in the script sandbox.
    fn js(&self, node: &GraphNode, entry: &str, code: &str, input: &Data) -> Result<Value, String> {
        {
            let mut st = self.st.borrow_mut();
            st.source = label(node);
            st.slots.insert("script".into(), code.to_string());
            st.slots.insert("input".into(), input.value.to_string());
        }
        let r = self.eval_str(entry)?;
        let v: Value = serde_json::from_str(&r).map_err(|e| e.to_string())?;
        match v.get("e") {
            Some(e) => Err(var_text(e)),
            None => Ok(v.get("v").cloned().unwrap_or(Value::Null)),
        }
    }

    /// Lets `{{input.x}}` resolve while `f` runs (paths of file nodes).
    fn with_input<T>(&self, input: &Data, f: impl FnOnce(&super::State) -> T) -> T {
        self.st.borrow_mut().graph_input = Some(input.value.clone());
        let r = f(&self.st.borrow());
        self.st.borrow_mut().graph_input = None;
        r
    }
}

/// Output of a request node: the body (or the whole response), or an error for
/// HTTP status ≥ 400 and failed tests unless `failOnError` is off.
fn request_output(res: &RequestResult, cfg: &serde_json::Map<String, Value>) -> Result<Data, String> {
    if let Some(e) = res.error.clone().or_else(|| res.script_errors.first().cloned()) {
        return Err(e);
    }
    let r = res.response.as_ref().ok_or("no response")?;
    if cfg.get("failOnError").and_then(Value::as_bool).unwrap_or(true) {
        if r.status >= 400 {
            return Err(format!("HTTP {} {}", r.status, r.status_text).trim().to_string());
        }
        if let Some(t) = res.tests.iter().find(|t| !t.passed) {
            return Err(format!("test failed: {}{}", t.name, t.error.as_ref().map(|e| format!(" — {e}")).unwrap_or_default()));
        }
    }
    let body = serde_json::from_str(&r.body).unwrap_or_else(|_| Value::String(r.body.clone()));
    if cfg.get("output").and_then(Value::as_str) == Some("response") {
        let mut headers = serde_json::Map::new();
        for (k, v) in &r.headers {
            let k = k.to_ascii_lowercase();
            let joined = match headers.get(&k).and_then(Value::as_str) {
                Some(prev) => format!("{prev}, {v}"),
                None => v.clone(),
            };
            headers.insert(k, Value::String(joined));
        }
        return Ok(Data::json(json!({ "status": r.status, "headers": headers, "body": body })));
    }
    Ok(match body {
        Value::String(s) => Data::text(s),
        v => Data::json(v),
    })
}

/// Collects a merge node's inputs; returns the merged value once every
/// connected source delivered (`mode`: object by source node id, or array).
fn merge_input(run: &mut Run, node: &GraphNode, from: Option<&str>, input: Data) -> Option<Data> {
    let mut sources: Vec<&str> = Vec::new();
    for e in run.graph.edges.iter().filter(|e| e.to == node.id) {
        if !sources.contains(&e.from.as_str()) {
            sources.push(&e.from);
        }
    }
    let got = run.merges.entry(node.id.clone()).or_default();
    got.insert(from.unwrap_or("").to_string(), input.value);
    if sources.iter().any(|s| !got.contains_key(*s)) {
        return None;
    }
    let got = run.merges.remove(&node.id).unwrap_or_default();
    let value = if node.cfg.get("mode").and_then(Value::as_str) == Some("array") {
        Value::Array(sources.iter().map(|s| got.get(*s).cloned().unwrap_or(Value::Null)).collect())
    } else {
        Value::Object(sources.iter().map(|s| (s.to_string(), got.get(*s).cloned().unwrap_or(Value::Null))).collect())
    };
    Some(Data::json(value))
}

/// A JSON array, or the rows of CSV text.
fn rows_of(input: &Data) -> Result<Vec<Value>, String> {
    match (input.kind, &input.value) {
        ("json", Value::Array(a)) => Ok(a.clone()),
        ("csv" | "text", Value::String(t)) => Ok(parse_csv(t, &json!({}))?.as_array().cloned().unwrap_or_default()),
        _ => Err("needs a JSON array or CSV".into()),
    }
}

fn label(n: &GraphNode) -> String {
    if n.name.is_empty() { format!("{} {}", n.kind, n.id) } else { n.name.clone() }
}

/// Checks (and where it is lossless converts) the input against the node's declared type.
fn check_input(node: &GraphNode, data: Data) -> Result<Data, String> {
    let want = node.input.as_str();
    let ok = match want {
        "" | "any" => true,
        "none" => return Ok(Data::none()),
        "json" if data.kind == "text" => {
            return serde_json::from_str(&data.as_text()).map(Data::json).map_err(|_| format!("{}: expects JSON input, got text", label(node)));
        }
        "json" => data.kind == "json",
        "csv" | "text" => matches!(data.kind, "csv" | "text"),
        "file" => data.kind == "file",
        _ => true,
    };
    if ok { Ok(data) } else { Err(format!("{}: expects {want} input, got {}", label(node), data.kind)) }
}
