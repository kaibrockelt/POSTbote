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

        let mut run = Run { graph: &graph, path, depth, steps: Vec::new(), count: 0, last: None };
        let first = input.map(Data::json).unwrap_or_else(Data::none);
        match self.visit(&mut run, entry, first) {
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
    fn visit(&self, run: &mut Run, node: &GraphNode, input: Data) -> Result<Option<Data>, String> {
        run.count += 1;
        if run.count > MAX_STEPS {
            return Err(format!("stopped after {MAX_STEPS} node executions (endless loop?)"));
        }
        if self.clock.cancelled() {
            return Err(self.clock.reason().into());
        }
        let started = Instant::now();
        let mut step = StepResult { node: node.id.clone(), kind: node.kind.clone(), name: node.name.clone(), ..Default::default() };
        let emit = match check_input(node, input) {
            Ok(data) => self.exec_node(run, node, data, &mut step),
            Err(e) => Err(e),
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
            if let Some(ret) = self.visit(run, n, data.clone())? {
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
            "call" => {
                let req = s("request");
                if req.is_empty() {
                    return Err("choose a request".into());
                }
                let use_folder = cfg.get("useFolder").and_then(Value::as_bool).unwrap_or(true);
                {
                    let mut st = self.st.borrow_mut();
                    st.graph_input = Some(input.value.clone());
                    // JSON fields override folder/collection variables, never the environment
                    st.input_vars = match &input.value {
                        Value::Object(o) if input.kind == "json" => o.iter().map(|(k, v)| (k.clone(), var_text(v))).collect(),
                        _ => BTreeMap::new(),
                    };
                    st.skip_folders = !use_folder;
                }
                let res = self.exec_request(&req, None);
                {
                    let mut st = self.st.borrow_mut();
                    st.graph_input = None;
                    st.input_vars.clear();
                    st.skip_folders = false;
                }
                let error = res.error.clone().or_else(|| res.script_errors.first().cloned());
                let body = res.response.as_ref().map(|r| r.body.clone());
                step.request = Some(res);
                if let Some(e) = error {
                    return Err(e);
                }
                let body = body.unwrap_or_default();
                out(serde_json::from_str(&body).map(Data::json).unwrap_or_else(|_| Data::text(body)))
            }
            "compute" => self.js(node, "__runCompute()", &s("code"), &input).map(Data::json).and_then(out),
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
            "forEach" => {
                let items = match (input.kind, &input.value) {
                    ("json", Value::Array(a)) => a.clone(),
                    ("csv" | "text", Value::String(t)) => parse_csv(t, &json!({}))?.as_array().cloned().unwrap_or_default(),
                    _ => return Err("forEach needs a JSON array or CSV".into()),
                };
                let child_id = s("child");
                let child = run.graph.nodes.iter().find(|n| n.id == child_id).ok_or("choose the node to run for every item")?;
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
                    "csv" => out(Data { kind: "csv", value: Value::String(fs.read(&path).map_err(|e| format!("{e:#}"))?) }),
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
