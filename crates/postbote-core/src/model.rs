//! The on-disk collection format.
//!
//! ```text
//! postbote.yaml                      collection manifest (name, settings, vars, headers, auth, scripts)
//! .gitignore                     managed block keeps *.env out of git by default
//! environments/<name>.env        private environment (gitignored)
//! environments/<name>.env.pub    public environment (committed)
//! requests/**/_folder.yaml       optional folder settings (headers, vars, auth, scripts)
//! requests/**/<name>.req.yaml    a request
//! runners/**/<name>.runner.yaml  a runner (request chain with data rows)
//! anything else                  free text files (e.g. data/*.csv) usable from scripts
//! ```

use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::fs::{Fs, is_not_found, parent};

pub const MANIFEST: &str = "postbote.yaml";
pub const FOLDER_FILE: &str = "_folder.yaml";
pub const REQUEST_EXT: &str = ".req.yaml";
pub const RUNNER_EXT: &str = ".runner.yaml";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Kv {
    pub key: String,
    pub value: String,
    pub file: String,
    pub disabled: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Scripts {
    pub pre: String,
    pub post: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Auth {
    /// inherit | none | bearer | basic | apikey
    #[serde(rename = "type")]
    pub kind: String,
    pub token: String,
    pub username: String,
    pub password: String,
    pub key: String,
    pub value: String,
    /// header | query
    #[serde(rename = "in")]
    pub location: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Body {
    /// none | json | text | xml | form | multipart
    #[serde(rename = "type")]
    pub kind: String,
    pub content: String,
    pub fields: Vec<Kv>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub commit_environments: bool,
    pub timeout_ms: Option<u64>,
    pub script_timeout_ms: Option<u64>,
    pub follow_redirects: Option<bool>,
    pub verify_tls: Option<bool>,
}

impl Settings {
    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms.filter(|v| *v > 0).unwrap_or(30_000)
    }
    pub fn script_timeout_ms(&self) -> u64 {
        self.script_timeout_ms.filter(|v| *v > 0).unwrap_or(10_000)
    }
    pub fn follow_redirects(&self) -> bool {
        self.follow_redirects.unwrap_or(true)
    }
    pub fn verify_tls(&self) -> bool {
        self.verify_tls.unwrap_or(true)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Collection {
    pub version: u32,
    pub name: String,
    pub settings: Settings,
    pub variables: BTreeMap<String, String>,
    pub headers: Vec<Kv>,
    pub auth: Option<Auth>,
    pub scripts: Scripts,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Folder {
    #[serde(skip)]
    pub path: String,
    pub name: String,
    pub variables: BTreeMap<String, String>,
    pub headers: Vec<Kv>,
    pub auth: Option<Auth>,
    pub scripts: Scripts,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Request {
    pub name: String,
    pub method: String,
    pub url: String,
    pub params: Vec<Kv>,
    pub headers: Vec<Kv>,
    pub auth: Option<Auth>,
    pub body: Body,
    pub scripts: Scripts,
    pub docs: String,
    pub seq: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Step {
    pub name: String,
    pub request: String,
    #[serde(rename = "if")]
    pub condition: String,
    pub scripts: Scripts,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowSettings {
    pub stop_on_failure: bool,
    pub delay_ms: u64,
    pub max_iterations: usize,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Workflow {
    pub name: String,
    pub data: String,
    pub steps: Vec<Step>,
    pub scripts: Scripts,
    pub settings: WorkflowSettings,
}

fn decode<T: for<'de> Deserialize<'de> + Default>(fs: &dyn Fs, p: &str) -> Result<T> {
    let text = fs.read(p)?;
    if text.trim().is_empty() {
        return Ok(T::default());
    }
    serde_norway::from_str(&text).with_context(|| format!("{p}: invalid YAML"))
}

/// Reads postbote.yaml; a missing manifest yields an empty collection.
pub fn load_collection(fs: &dyn Fs) -> Result<Collection> {
    match decode(fs, MANIFEST) {
        Err(e) if is_not_found(&e) => Ok(Collection { version: 1, ..Default::default() }),
        r => r,
    }
}

pub fn load_request(fs: &dyn Fs, p: &str) -> Result<Request> {
    if !p.ends_with(REQUEST_EXT) {
        bail!("{p} is not a request file (*{REQUEST_EXT})");
    }
    decode(fs, p)
}

pub fn load_workflow(fs: &dyn Fs, p: &str) -> Result<Workflow> {
    if !p.ends_with(RUNNER_EXT) {
        bail!("{p} is not a runner file (*{RUNNER_EXT})");
    }
    decode(fs, p)
}

/// Folder settings of every ancestor directory of a request, outermost first.
/// Directories without `_folder.yaml` are skipped.
pub fn load_folder_chain(fs: &dyn Fs, req_path: &str) -> Result<Vec<Folder>> {
    let mut dirs = Vec::new();
    let mut d = parent(req_path);
    while !d.is_empty() {
        dirs.push(d.to_string());
        d = parent(d);
    }
    dirs.reverse();
    let mut out = Vec::new();
    for d in dirs {
        match decode::<Folder>(fs, &format!("{d}/{FOLDER_FILE}")) {
            Ok(mut f) => {
                f.path = d;
                out.push(f);
            }
            Err(e) if is_not_found(&e) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

pub const ENV_DIR: &str = "environments";

/// Shared, committed values of an environment.
pub fn env_public_path(name: &str) -> String {
    format!("{ENV_DIR}/{name}.env.pub")
}

/// Private values (gitignored) that override the shared ones.
pub fn env_private_path(name: &str) -> String {
    format!("{ENV_DIR}/{name}.env")
}

pub fn check_env_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 100 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) || name.starts_with('.') {
        bail!("invalid environment name {name:?}");
    }
    Ok(())
}

pub fn enabled(kvs: &[Kv]) -> impl Iterator<Item = &Kv> {
    kvs.iter().filter(|kv| !kv.disabled && !kv.key.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::MemFs;

    #[test]
    fn parses_request_and_folders() {
        let mut files = BTreeMap::new();
        files.insert("requests/users/_folder.yaml".into(), "headers:\n  - key: X-A\n    value: '1'\n".into());
        files.insert(
            "requests/users/get.req.yaml".into(),
            "name: Get\nmethod: GET\nurl: '{{base}}/u'\nbody:\n  type: json\n  content: |\n    {\"a\": 1}\n".into(),
        );
        let fs = MemFs::new(files).unwrap();
        let r = load_request(&fs, "requests/users/get.req.yaml").unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.body.kind, "json");
        let chain = load_folder_chain(&fs, "requests/users/get.req.yaml").unwrap();
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].headers[0].value, "1");
        assert_eq!(load_collection(&fs).unwrap().version, 1);
    }
}
