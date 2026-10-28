//! Native side of the script API: every `__host(op, args)` call from the
//! prelude lands in [`State::host`].

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde_json::{Map, Value, json};
use sha2::Digest;

use super::State;
use super::http::{OutBody, OutReq};
use crate::fs::{Fs, is_not_found, list_dir};

type HostResult = Result<Option<Value>, String>;

fn arg_str(args: &[Value], i: usize) -> String {
    match args.get(i) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}

fn some<T: Into<Value>>(v: T) -> HostResult {
    Ok(Some(v.into()))
}

pub fn value_to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}

impl State {
    pub(super) fn host(&mut self, op: &str, args: &[Value]) -> HostResult {
        let e = |err: anyhow::Error| format!("{err:#}");
        match op {
            "test" => {
                self.tests.push(super::TestResult {
                    name: arg_str(args, 0),
                    passed: args.get(1).and_then(Value::as_bool).unwrap_or(false),
                    error: Some(arg_str(args, 2)).filter(|s| !s.is_empty()),
                    source: self.source.clone(),
                });
                Ok(None)
            }
            "log" => {
                self.logs.push(super::LogEntry { level: arg_str(args, 0), message: arg_str(args, 1), source: self.source.clone() });
                Ok(None)
            }
            "slot" => some(self.slots.get(&arg_str(args, 0)).cloned().unwrap_or_default()),

            "cookies.get" => {
                let url = Some(arg_str(args, 1)).filter(|u| !u.is_empty()).map(|u| url::Url::parse(&u)).transpose().map_err(|e| format!("cookies.get: {e}"))?;
                Ok(self.jar.get(&arg_str(args, 0), url.as_ref()).map(Value::String))
            }
            "cookies.all" => some(Value::Array(self.jar.all())),
            "cookies.set" => {
                let url = url::Url::parse(&arg_str(args, 2)).map_err(|e| format!("cookies.set needs the URL the cookie belongs to: {e}"))?;
                self.jar.set(&arg_str(args, 0), &arg_str(args, 1), &url)?;
                Ok(None)
            }
            "cookies.clear" => {
                self.jar.clear();
                Ok(None)
            }

            "env.name" => Ok(self.env_name.clone().map(Value::String)),
            "env.get" => Ok(self.env.get(&arg_str(args, 0)).cloned().map(Value::String)),
            "env.set" => {
                let (k, v) = (arg_str(args, 0), arg_str(args, 1));
                if self.env_path.is_none() {
                    self.log("warn", format!("env.set({k:?}): no environment selected, value is kept for this run only"));
                }
                if !self.env.contains_key(&k) {
                    self.env_order.push(k.clone());
                }
                self.env.insert(k.clone(), v.clone());
                self.env_changes.insert(k, Some(v));
                Ok(None)
            }
            "env.unset" => {
                let k = arg_str(args, 0);
                self.env.remove(&k);
                self.env_changes.insert(k, None);
                Ok(None)
            }
            "env.all" => some(Value::Object(self.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())),

            "vars.get" => Ok(self.vars.get(&arg_str(args, 0)).cloned()),
            "vars.set" => {
                self.vars.insert(arg_str(args, 0), arg(args, 1));
                Ok(None)
            }
            "vars.unset" => {
                self.vars.remove(&arg_str(args, 0));
                Ok(None)
            }
            "vars.has" => some(self.vars.contains_key(&arg_str(args, 0))),
            "vars.all" => some(Value::Object(self.vars.clone())),
            "vars.resolve" => Ok(self.lookup(&arg_str(args, 0)).map(Value::String)),
            "interpolate" => some(self.interp(&arg_str(args, 0))),
            "collection" => some(json!({ "name": self.col.name, "vars": self.col.variables })),

            "fs.read" => some(self.fs.read(&arg_str(args, 0)).map_err(e)?),
            "fs.exists" => some(self.fs.read(&arg_str(args, 0)).is_ok()),
            "fs.write" => {
                self.fs.write(&arg_str(args, 0), &arg_str(args, 1)).map_err(e)?;
                Ok(None)
            }
            "fs.append" => {
                let p = arg_str(args, 0);
                let old = match self.fs.read(&p) {
                    Ok(s) => s,
                    Err(err) if is_not_found(&err) => String::new(),
                    Err(err) => return Err(e(err)),
                };
                self.fs.write(&p, &(old + &arg_str(args, 1))).map_err(e)?;
                Ok(None)
            }
            "fs.remove" => {
                self.fs.delete(&arg_str(args, 0)).map_err(e)?;
                Ok(None)
            }
            "fs.list" => some(list_dir(&self.fs, &arg_str(args, 0)).map_err(e)?),

            "csv.parse" => some(parse_csv(&arg_str(args, 0), &arg(args, 1))?),
            "csv.stringify" => some(stringify_csv(&arg(args, 0), &arg(args, 1))?),

            "uuid" => some(uuid()),
            "base64.encode" => some(base64::engine::general_purpose::STANDARD.encode(arg_str(args, 0))),
            "base64.decode" => {
                let s = arg_str(args, 0);
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(s.trim())
                    .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim().trim_end_matches('=')))
                    .map_err(|err| err.to_string())?;
                some(String::from_utf8_lossy(&bytes).to_string())
            }
            "hash" => some(hash(&arg_str(args, 0), arg_str(args, 1).as_bytes())?),
            "hmac" => some(hmac(&arg_str(args, 0), arg_str(args, 1).as_bytes(), arg_str(args, 2).as_bytes())?),
            "sleep" => {
                let ms = args.first().and_then(Value::as_u64).unwrap_or(0).min(10_000);
                self.pause(|st| st.sleep(Duration::from_millis(ms)));
                Ok(None)
            }
            "send" => {
                let req = script_request(&arg(args, 0))?;
                let res = self.pause(|st| st.http.send(&req))?;
                some(serde_json::to_value(&res).map_err(|err| err.to_string())?)
            }
            other => Err(format!("unknown host operation {other:?}")),
        }
    }

    /// Runs blocking host work without it counting against the script timeout.
    fn pause<T>(&mut self, f: impl FnOnce(&mut State) -> T) -> T {
        let start = Instant::now();
        let out = f(self);
        self.clock.extend(start.elapsed());
        out
    }

    pub(super) fn sleep(&self, d: Duration) {
        let until = Instant::now() + d;
        while Instant::now() < until && !self.clock.cancelled() {
            std::thread::sleep(Duration::from_millis(20).min(until.saturating_duration_since(Instant::now())));
        }
    }
}

fn script_request(v: &Value) -> Result<OutReq, String> {
    let o = v.as_object().ok_or("sendRequest expects an object or URL")?;
    let get = |k: &str| o.get(k).map(value_to_text).unwrap_or_default();
    let url = get("url");
    if url.is_empty() {
        return Err("sendRequest: url is required".into());
    }
    let mut headers = Vec::new();
    if let Some(Value::Object(h)) = o.get("headers") {
        for (k, v) in h {
            headers.push((k.clone(), value_to_text(v)));
        }
    }
    let body = match o.get("body") {
        None | Some(Value::Null) => OutBody::None,
        Some(Value::String(s)) => OutBody::Raw(s.clone()),
        Some(other) => {
            if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
                headers.push(("Content-Type".into(), "application/json".into()));
            }
            OutBody::Raw(other.to_string())
        }
    };
    let method = Some(get("method").to_uppercase()).filter(|m| !m.is_empty()).unwrap_or_else(|| "GET".into());
    Ok(OutReq { method, url, headers, body })
}

pub fn uuid() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn norm_alg(alg: &str) -> String {
    alg.to_ascii_lowercase().replace('-', "")
}

fn hash(alg: &str, data: &[u8]) -> Result<String, String> {
    Ok(match norm_alg(alg).as_str() {
        "" | "sha256" => hex::encode(sha2::Sha256::digest(data)),
        "sha512" => hex::encode(sha2::Sha512::digest(data)),
        "sha1" => hex::encode(sha1::Sha1::digest(data)),
        "md5" => hex::encode(md5::Md5::digest(data)),
        a => return Err(format!("unsupported hash algorithm {a:?}")),
    })
}

fn hmac(alg: &str, key: &[u8], msg: &[u8]) -> Result<String, String> {
    fn run<M: Mac + hmac::digest::KeyInit>(key: &[u8], msg: &[u8]) -> String {
        let mut m = <M as hmac::digest::KeyInit>::new_from_slice(key).expect("hmac accepts any key length");
        m.update(msg);
        hex::encode(m.finalize().into_bytes())
    }
    Ok(match norm_alg(alg).as_str() {
        "" | "sha256" => run::<Hmac<sha2::Sha256>>(key, msg),
        "sha512" => run::<Hmac<sha2::Sha512>>(key, msg),
        "sha1" => run::<Hmac<sha1::Sha1>>(key, msg),
        a => return Err(format!("unsupported hmac algorithm {a:?}")),
    })
}

fn delimiter(opts: &Value) -> u8 {
    opts.get("delimiter").and_then(Value::as_str).and_then(|s| s.bytes().next()).unwrap_or(b',')
}

/// Objects keyed by the header row (default) or raw arrays with `{header: false}`.
pub fn parse_csv(text: &str, opts: &Value) -> Result<Value, String> {
    let header = opts.get("header").and_then(Value::as_bool).unwrap_or(true);
    let mut rd = csv::ReaderBuilder::new()
        .delimiter(delimiter(opts))
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let mut recs = Vec::new();
    for r in rd.records() {
        recs.push(r.map_err(|e| e.to_string())?);
    }
    if !header {
        return Ok(Value::Array(recs.iter().map(|r| Value::Array(r.iter().map(|f| Value::String(f.into())).collect())).collect()));
    }
    let Some(cols) = recs.first().cloned() else { return Ok(Value::Array(vec![])) };
    let rows = recs[1..]
        .iter()
        .map(|r| {
            let mut m = Map::new();
            for (i, c) in cols.iter().enumerate() {
                m.insert(c.to_string(), Value::String(r.get(i).unwrap_or("").to_string()));
            }
            Value::Object(m)
        })
        .collect();
    Ok(Value::Array(rows))
}

pub fn stringify_csv(rows: &Value, opts: &Value) -> Result<String, String> {
    let rows = rows.as_array().ok_or("csv.stringify expects an array")?;
    let mut cols: Vec<String> = opts
        .get("columns")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(value_to_text).collect())
        .unwrap_or_default();
    if cols.is_empty() {
        let mut seen = BTreeMap::new();
        for r in rows {
            if let Value::Object(m) = r {
                for k in m.keys() {
                    if !seen.contains_key(k) {
                        seen.insert(k.clone(), ());
                        cols.push(k.clone());
                    }
                }
            }
        }
    }
    let mut w = csv::WriterBuilder::new().delimiter(delimiter(opts)).flexible(true).from_writer(Vec::new());
    if !cols.is_empty() {
        w.write_record(&cols).map_err(|e| e.to_string())?;
    }
    for r in rows {
        let rec: Vec<String> = match r {
            Value::Object(m) => cols.iter().map(|c| m.get(c).map(value_to_text).unwrap_or_default()).collect(),
            Value::Array(a) => a.iter().map(value_to_text).collect(),
            v => vec![value_to_text(v)],
        };
        w.write_record(&rec).map_err(|e| e.to_string())?;
    }
    String::from_utf8(w.into_inner().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
