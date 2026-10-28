//! Disk-backed collections ("workspaces").
//!
//! * local mode: collections live in one collections folder (default
//!   `~/Documents/POSTBote`, chosen on first run) and are discovered by
//!   scanning it. Folders elsewhere can be added as external collections;
//!   removing those only unregisters them. Stored in
//!   `<config dir>/postbote/config.json`.
//! * server mode: `<data>/users/<user>/<id>/`, only for users that opted in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use postbote_core::fs::{DiskFs, Fs};
use postbote_core::model;
use serde::{Deserialize, Serialize};
use sha2::Digest;

use crate::auth::user_dir_name;
use crate::{AppState, Mode};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub collections_dir: Option<PathBuf>,
    #[serde(default)]
    pub external: Vec<Entry>,
}

#[derive(Debug, Serialize)]
pub struct Info {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub storage: &'static str,
    /// lives in the collections folder (cannot be unregistered, only deleted on disk)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub managed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------- local config

fn config_file() -> Result<PathBuf> {
    let dir = dirs::config_dir().context("no config directory on this system")?.join("postbote");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("config.json"))
}

pub fn load_config() -> Result<AppConfig> {
    match std::fs::read_to_string(config_file()?) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AppConfig::default()),
        Err(e) => Err(e.into()),
    }
}

fn save_config(c: &AppConfig) -> Result<()> {
    std::fs::write(config_file()?, serde_json::to_string_pretty(c)?)?;
    Ok(())
}

/// `~/Documents/POSTBote` (resp. the platform's documents folder).
pub fn default_collections_dir() -> PathBuf {
    dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Documents")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("POSTBote")
}

fn expand(raw: &str) -> Result<PathBuf> {
    let raw = raw.trim();
    let p = match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        Some(rest) => dirs::home_dir().context("no home directory")?.join(rest),
        None if raw == "~" => dirs::home_dir().context("no home directory")?,
        None => PathBuf::from(raw),
    };
    if !p.is_absolute() {
        bail!("please use an absolute folder path");
    }
    Ok(p)
}

pub fn set_collections_dir(raw: &str) -> Result<PathBuf> {
    let dir = expand(raw)?;
    std::fs::create_dir_all(&dir).with_context(|| format!("cannot create {}", dir.display()))?;
    let dir = dir.canonicalize()?;
    let mut c = load_config()?;
    c.collections_dir = Some(dir.clone());
    save_config(&c)?;
    Ok(dir)
}

fn path_id(p: &Path) -> String {
    hex::encode(&sha2::Sha256::digest(p.to_string_lossy().as_bytes())[..6])
}

/// Every local collection: those in the collections folder, then external ones.
fn local_entries(c: &AppConfig) -> Vec<(Entry, bool)> {
    let mut out: Vec<(Entry, bool)> = Vec::new();
    if let Some(home) = &c.collections_dir {
        if let Ok(rd) = std::fs::read_dir(home) {
            let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.join(model::MANIFEST).is_file()).collect();
            dirs.sort();
            for p in dirs {
                let p = p.canonicalize().unwrap_or(p);
                out.push((Entry { id: path_id(&p), path: p }, true));
            }
        }
    }
    for e in &c.external {
        if !out.iter().any(|(o, _)| o.id == e.id) {
            out.push((e.clone(), false));
        }
    }
    out
}

fn user_root(data_dir: &Path, user: &str) -> PathBuf {
    data_dir.join("users").join(user_dir_name(user))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn collection_name(dir: &Path) -> (String, Option<String>) {
    let fallback = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    match DiskFs::open(dir).and_then(|fs| model::load_collection(&fs)) {
        Ok(c) if !c.name.is_empty() => (c.name, None),
        Ok(_) => (fallback, None),
        Err(e) => (fallback, Some(format!("{e:#}"))),
    }
}

pub fn list(state: &AppState, user: &str) -> Result<Vec<Info>> {
    match &state.cfg.mode {
        Mode::Local { .. } => Ok(local_entries(&load_config()?)
            .into_iter()
            .map(|(e, managed)| {
                let (name, mut error) = collection_name(&e.path);
                if !e.path.join(model::MANIFEST).exists() {
                    error = Some("folder or postbote.yaml not found".into());
                }
                Info { id: e.id, name, path: Some(e.path.display().to_string()), storage: "disk", managed, error }
            })
            .collect()),
        Mode::Server { data_dir, .. } => {
            let root = user_root(data_dir, user);
            let mut out = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&root) {
                for e in rd.flatten() {
                    let id = e.file_name().to_string_lossy().to_string();
                    if e.path().is_dir() && valid_id(&id) {
                        let (name, error) = collection_name(&e.path());
                        out.push(Info { id, name, path: None, storage: "server", managed: false, error });
                    }
                }
            }
            out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            Ok(out)
        }
    }
}

/// Directory of a workspace the user may access.
pub fn resolve(state: &AppState, user: &str, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        bail!("invalid workspace id");
    }
    match &state.cfg.mode {
        Mode::Local { .. } => local_entries(&load_config()?).into_iter().find(|(e, _)| e.id == id).map(|(e, _)| e.path).context("unknown workspace"),
        Mode::Server { data_dir, .. } => {
            let p = user_root(data_dir, user).join(id);
            if !p.is_dir() {
                bail!("unknown workspace");
            }
            Ok(p)
        }
    }
}

pub fn open_fs(state: &AppState, user: &str, id: &str) -> Result<DiskFs> {
    DiskFs::open(resolve(state, user, id)?)
}

fn unique_dir(parent: &Path, name: &str) -> PathBuf {
    let base = crate::api::slug(name);
    let mut p = parent.join(&base);
    let mut i = 2;
    while p.exists() {
        p = parent.join(format!("{base}-{i}"));
        i += 1;
    }
    p
}

/// Local mode: `path` opens/adds an existing folder (or writes `files` into it
/// when it has no manifest yet); without `path` a new collection folder is
/// created inside the collections folder.
pub fn create(state: &AppState, user: &str, name: Option<&str>, path: Option<&str>, files: &BTreeMap<String, String>) -> Result<String> {
    match &state.cfg.mode {
        Mode::Local { .. } => {
            let mut cfg = load_config()?;
            let dir = match path.map(str::trim).filter(|p| !p.is_empty()) {
                Some(raw) => expand(raw)?,
                None => {
                    let home = cfg.collections_dir.clone().context("choose a collections folder first")?;
                    if files.is_empty() {
                        bail!("nothing to create");
                    }
                    unique_dir(&home, name.unwrap_or("collection"))
                }
            };
            let has_manifest = dir.join(model::MANIFEST).exists();
            if !has_manifest && files.is_empty() {
                bail!("this folder contains no postbote.yaml");
            }
            let mut fs = DiskFs::open(&dir)?;
            if !has_manifest {
                for (p, c) in files {
                    fs.write(p, c)?;
                }
            }
            let canon = fs.root().to_path_buf();
            let id = path_id(&canon);
            let managed = cfg.collections_dir.as_ref().is_some_and(|h| canon.parent() == Some(h.as_path()));
            if !managed && !cfg.external.iter().any(|e| e.id == id) {
                cfg.external.push(Entry { id: id.clone(), path: canon });
                save_config(&cfg)?;
            }
            Ok(id)
        }
        Mode::Server { data_dir, allow_server_storage, .. } => {
            if !allow_server_storage {
                bail!("server-side storage is disabled on this instance");
            }
            let id = hex::encode(rand::random::<[u8; 6]>());
            let mut fs = DiskFs::open(user_root(data_dir, user).join(&id))?;
            for (p, c) in files {
                fs.write(p, c)?;
            }
            Ok(id)
        }
    }
}

pub fn remove(state: &AppState, user: &str, id: &str) -> Result<()> {
    match &state.cfg.mode {
        Mode::Local { .. } => {
            let mut cfg = load_config()?;
            if !cfg.external.iter().any(|e| e.id == id) {
                bail!("this collection lives in your collections folder; move or delete its folder to remove it");
            }
            cfg.external.retain(|e| e.id != id);
            save_config(&cfg)
        }
        Mode::Server { .. } => {
            let dir = resolve(state, user, id)?;
            std::fs::remove_dir_all(dir)?;
            Ok(())
        }
    }
}
