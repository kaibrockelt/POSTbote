//! JSON API used by the web UI.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use postbote_core::fs::{Fs, MemFs, Overlay};
use postbote_core::runner::{self, RunOptions, RunOutput, Target};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, User};
use crate::{AppState, AuthMode, Mode, workspaces};

const MAX_BODY: usize = 32 << 20;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError(StatusCode::BAD_REQUEST, format!("{e:#}"))
    }
}

fn err(status: StatusCode, msg: impl Into<String>) -> ApiError {
    ApiError(status, msg.into())
}

type ApiResult<T> = Result<T, ApiError>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> ApiResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.map_err(Into::into)
}

pub fn routes(_state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/info", get(info))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/workspaces", get(list_workspaces).post(create_workspace))
        .route("/api/workspaces/{id}", axum::routing::delete(delete_workspace))
        .route("/api/workspaces/{id}/trash", post(trash_workspace))
        .route("/api/workspaces/{id}/files", get(get_files))
        .route("/api/workspaces/{id}/files/{*path}", put(put_file).delete(delete_file))
        .route("/api/workspaces/{id}/rename", post(rename_file))
        .route("/api/run", post(run))
        .route("/api/export", post(export_zip))
        .route("/api/import", post(import_zip))
        .route("/api/browse", get(browse))
        .route("/api/setup", post(setup))
        .route("/api/session/{id}", get(get_session).put(put_session))
        .route("/api/last-workspace/{id}", put(put_last_workspace))
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

/// Global middleware: local token bootstrap, CSRF guard, security headers.
pub async fn entry(State(s): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if let Mode::Local { token } = &s.cfg.mode {
        let given = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")));
        if let Some(t) = given {
            if auth::constant_eq(t.as_bytes(), token.as_bytes()) {
                let cookie = format!("{}={token}; Path=/; HttpOnly; SameSite=Strict", auth::TOKEN_COOKIE);
                return (StatusCode::SEE_OTHER, [(header::LOCATION, "/".to_string()), (header::SET_COOKIE, cookie)]).into_response();
            }
        }
    }
    // Mutations need a custom header: browsers cannot send it cross-origin
    // without a CORS preflight, which we never allow.
    let is_api = req.uri().path().starts_with("/api/");
    if is_api && !matches!(*req.method(), Method::GET | Method::HEAD) && req.headers().get("x-postbote").is_none_or(|v| v != "1") {
        return err(StatusCode::FORBIDDEN, "missing X-Postbote header").into_response();
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
             connect-src 'self' ipc: http://ipc.localhost; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    );
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if is_api {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

// ---------------------------------------------------------------- session

async fn info(State(s): State<Arc<AppState>>, headers: HeaderMap) -> Json<Value> {
    let user = auth::current_user(&s, &headers);
    let (mode, auth, server_storage) = match &s.cfg.mode {
        Mode::Local { .. } => ("local", "token", false),
        Mode::Server { auth, allow_server_storage, .. } => (
            "server",
            match auth {
                AuthMode::None => "none",
                AuthMode::Local => "local",
                AuthMode::Header(_) => "header",
            },
            *allow_server_storage,
        ),
    };
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "mode": mode,
        "auth": auth,
        "authenticated": user.is_some(),
        "user": user,
        "serverStorage": server_storage,
        "denyPrivateNetworks": s.cfg.deny_private_networks,
        "home": if s.is_local() { dirs::home_dir().map(|h| h.display().to_string()) } else { None },
        "setup": local_setup(&s),
    }))
}

/// First-run state of the local app: where collections are stored.
fn local_setup(s: &AppState) -> Value {
    if !s.is_local() {
        return Value::Null;
    }
    let cfg = workspaces::load_config().unwrap_or_default();
    json!({
        "needed": cfg.collections_dir.is_none(),
        "collectionsDir": cfg.collections_dir.map(|p| p.display().to_string()),
        "defaultCollectionsDir": workspaces::default_collections_dir().display().to_string(),
        "lastWorkspace": workspaces::last_workspace(),
    })
}

async fn get_session(State(s): State<Arc<AppState>>, _u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if !s.is_local() {
        return Err(err(StatusCode::NOT_FOUND, "sessions are stored in the browser in server mode"));
    }
    let session = blocking(move || workspaces::load_session(&id)).await?;
    Ok(Json(json!({ "session": session })))
}

async fn put_session(State(s): State<Arc<AppState>>, _u: User, Path(id): Path<String>, Json(v): Json<Value>) -> ApiResult<Json<Value>> {
    if !s.is_local() {
        return Err(err(StatusCode::NOT_FOUND, "sessions are stored in the browser in server mode"));
    }
    blocking(move || workspaces::save_session(&id, &v)).await?;
    Ok(Json(json!({})))
}

async fn put_last_workspace(State(s): State<Arc<AppState>>, _u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if !s.is_local() {
        return Err(err(StatusCode::NOT_FOUND, "only available in the local app"));
    }
    blocking(move || workspaces::set_last_workspace(&id)).await?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Setup {
    collections_dir: String,
}

async fn setup(State(s): State<Arc<AppState>>, _u: User, Json(b): Json<Setup>) -> ApiResult<Json<Value>> {
    if !s.is_local() {
        return Err(err(StatusCode::FORBIDDEN, "only available in the local app"));
    }
    let _lock = s.registry_lock.lock().await;
    let dir = blocking(move || workspaces::set_collections_dir(&b.collections_dir)).await?;
    Ok(Json(json!({ "collectionsDir": dir.display().to_string() })))
}

#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
}

async fn login(State(s): State<Arc<AppState>>, Json(l): Json<Login>) -> ApiResult<Response> {
    let Mode::Server { data_dir, auth: AuthMode::Local, .. } = &s.cfg.mode else {
        return Err(err(StatusCode::BAD_REQUEST, "password login is not enabled"));
    };
    let dir = data_dir.clone();
    let user = l.username.trim().to_string();
    let u2 = user.clone();
    let ok = blocking(move || Ok(auth::check_password(&dir, &u2, &l.password))).await?;
    if !ok {
        tokio::time::sleep(Duration::from_millis(400)).await;
        return Err(err(StatusCode::UNAUTHORIZED, "invalid user name or password"));
    }
    let cookie = auth::session_cookie(&auth::make_session(&s.secret, &user), auth::session_max_age(), s.cfg.secure_cookies);
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "user": user }))).into_response())
}

async fn logout(State(s): State<Arc<AppState>>) -> Response {
    ([(header::SET_COOKIE, auth::session_cookie("", 0, s.cfg.secure_cookies))], Json(json!({}))).into_response()
}

// ---------------------------------------------------------------- workspaces

async fn list_workspaces(State(s): State<Arc<AppState>>, User(u): User) -> ApiResult<Json<Value>> {
    let st = s.clone();
    let list = blocking(move || workspaces::list(&st, &u)).await?;
    Ok(Json(json!({ "workspaces": list })))
}

#[derive(Deserialize)]
struct CreateWs {
    name: Option<String>,
    path: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

async fn create_workspace(State(s): State<Arc<AppState>>, User(u): User, Json(c): Json<CreateWs>) -> ApiResult<Json<Value>> {
    let _lock = s.registry_lock.lock().await;
    let st = s.clone();
    let id = blocking(move || workspaces::create(&st, &u, c.name.as_deref(), c.path.as_deref(), &c.files)).await?;
    Ok(Json(json!({ "id": id })))
}

async fn delete_workspace(State(s): State<Arc<AppState>>, User(u): User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let _lock = s.registry_lock.lock().await;
    let st = s.clone();
    blocking(move || workspaces::remove(&st, &u, &id)).await?;
    Ok(Json(json!({})))
}

async fn trash_workspace(State(s): State<Arc<AppState>>, User(u): User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let _lock = s.registry_lock.lock().await;
    let st = s.clone();
    blocking(move || workspaces::trash(&st, &u, &id)).await?;
    Ok(Json(json!({})))
}

async fn get_files(State(s): State<Arc<AppState>>, User(u): User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let files = blocking(move || workspaces::open_fs(&s, &u, &id)?.list()).await?;
    Ok(Json(json!({ "files": files })))
}

async fn put_file(State(s): State<Arc<AppState>>, User(u): User, Path((id, path)): Path<(String, String)>, body: String) -> ApiResult<Json<Value>> {
    blocking(move || workspaces::open_fs(&s, &u, &id)?.write(&path, &body)).await?;
    Ok(Json(json!({})))
}

async fn delete_file(State(s): State<Arc<AppState>>, User(u): User, Path((id, path)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    blocking(move || workspaces::open_fs(&s, &u, &id)?.delete(&path)).await?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
struct Rename {
    from: String,
    to: String,
}

async fn rename_file(State(s): State<Arc<AppState>>, User(u): User, Path(id): Path<String>, Json(r): Json<Rename>) -> ApiResult<Json<Value>> {
    blocking(move || workspaces::open_fs(&s, &u, &id)?.rename(&r.from, &r.to)).await?;
    Ok(Json(json!({})))
}

// ---------------------------------------------------------------- run

#[derive(Deserialize)]
struct RunReq {
    /// disk-backed workspace, or…
    workspace: Option<String>,
    /// …the files of a browser-stored collection (processed in memory only)
    files: Option<BTreeMap<String, String>>,
    /// unsaved editor content that should be used instead of the saved files
    #[serde(default)]
    overrides: BTreeMap<String, String>,
    kind: String,
    path: String,
    env: Option<String>,
    /// runner rows from the editor (replaces the data file)
    data: Option<String>,
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

async fn run(State(s): State<Arc<AppState>>, User(u): User, Json(r): Json<RunReq>) -> ApiResult<Json<RunOutput>> {
    let target = match r.kind.as_str() {
        "request" => Target::Request(r.path),
        "workflow" => Target::Workflow(r.path),
        k => return Err(err(StatusCode::BAD_REQUEST, format!("unknown run kind {k:?}"))),
    };
    let env = r.env.filter(|e| !e.is_empty());
    if let Some(e) = &env {
        postbote_core::model::check_env_name(e)?;
    }
    let _permit = s.runs.acquire().await.map_err(|e| err(StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    let fs: Box<dyn Fs> = match (&r.workspace, r.files) {
        (Some(id), _) => {
            let (st, id) = (s.clone(), id.clone());
            Box::new(blocking(move || workspaces::open_fs(&st, &u, &id)).await?)
        }
        (None, Some(files)) => Box::new(MemFs::new(files)?),
        (None, None) => return Err(err(StatusCode::BAD_REQUEST, "workspace or files required")),
    };
    let fs: Box<dyn Fs> = if r.overrides.is_empty() { fs } else { Box::new(Overlay::new(fs, r.overrides)?) };
    // a disconnected client cancels the run
    let cancel = Arc::new(AtomicBool::new(false));
    let _guard = CancelOnDrop(cancel.clone());
    let opts = RunOptions {
        env,
        deny_private: s.cfg.deny_private_networks,
        max_duration: Duration::from_secs(s.cfg.max_run_seconds),
        memory_limit: s.cfg.memory_limit_mb << 20,
        cancel,
        data: r.data,
        ..Default::default()
    };
    let out = tokio::task::spawn_blocking(move || runner::run(fs, target, opts))
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(out))
}

// ---------------------------------------------------------------- import / export

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    name: String,
    files: BTreeMap<String, String>,
    /// local app: write the zip to this file (chosen in a native save dialog)
    save_path: Option<String>,
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches(['-', '.']).to_string();
    if out.is_empty() { "collection".into() } else { out }
}

async fn export_zip(State(s): State<Arc<AppState>>, _u: User, Json(e): Json<Export>) -> ApiResult<Response> {
    let name = slug(&e.name);
    let n2 = name.clone();
    let save_path = e.save_path.clone();
    if save_path.is_some() && !s.is_local() {
        return Err(err(StatusCode::FORBIDDEN, "only available in the local app"));
    }
    let bytes = blocking(move || {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (p, content) in &e.files {
            let p = postbote_core::fs::clean(p)?;
            w.start_file(format!("{n2}/{p}"), opts)?;
            w.write_all(content.as_bytes())?;
        }
        Ok(w.finish()?.into_inner())
    })
    .await?;
    if let Some(p) = save_path {
        let path = std::path::PathBuf::from(&p);
        if !path.is_absolute() {
            return Err(err(StatusCode::BAD_REQUEST, "save path must be absolute"));
        }
        let len = bytes.len();
        blocking(move || Ok(std::fs::write(path, bytes)?)).await?;
        return Ok(Json(json!({ "saved": p, "size": len })).into_response());
    }
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}.zip\"")),
        ],
        bytes,
    )
        .into_response())
}

async fn import_zip(_u: User, body: Bytes) -> ApiResult<Json<Value>> {
    let (files, skipped) = blocking(move || unzip(&body)).await?;
    Ok(Json(json!({ "files": files, "skipped": skipped })))
}

/// Text files of a zip. A single top-level folder (zipped directory) is stripped.
pub fn unzip(bytes: &[u8]) -> anyhow::Result<(BTreeMap<String, String>, Vec<String>)> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut files = BTreeMap::new();
    let mut skipped = Vec::new();
    let mut total = 0usize;
    for i in 0..z.len() {
        let mut f = z.by_index(i)?;
        if f.is_dir() {
            continue;
        }
        let name = f.name()?.to_string();
        if name.starts_with("__MACOSX/") || name.ends_with(".DS_Store") {
            continue;
        }
        let Ok(path) = postbote_core::fs::clean(&name) else {
            skipped.push(name);
            continue;
        };
        if f.size() as usize > postbote_core::fs::MAX_FILE_SIZE {
            skipped.push(path);
            continue;
        }
        let mut buf = Vec::new();
        f.by_ref().take(postbote_core::fs::MAX_FILE_SIZE as u64 + 1).read_to_end(&mut buf)?;
        total += buf.len();
        anyhow::ensure!(total <= 64 << 20, "archive too large");
        match String::from_utf8(buf) {
            Ok(text) => {
                files.insert(path, text);
            }
            Err(_) => skipped.push(path),
        }
        anyhow::ensure!(files.len() <= postbote_core::fs::MAX_FILES, "too many files");
    }
    if !files.contains_key(postbote_core::model::MANIFEST) {
        let firsts: std::collections::BTreeSet<_> = files.keys().map(|k| k.split('/').next().unwrap_or("").to_string()).collect();
        if firsts.len() == 1 && files.keys().all(|k| k.contains('/')) {
            let prefix = format!("{}/", firsts.into_iter().next().unwrap());
            files = files.into_iter().map(|(k, v)| (k[prefix.len()..].to_string(), v)).collect();
        }
    }
    Ok((files, skipped))
}

// ---------------------------------------------------------------- folder picker (local mode)

#[derive(Deserialize)]
struct BrowseQuery {
    path: Option<String>,
}

async fn browse(State(s): State<Arc<AppState>>, _u: User, Query(q): Query<BrowseQuery>) -> ApiResult<Json<Value>> {
    if !s.is_local() {
        return Err(err(StatusCode::FORBIDDEN, "only available in the local app"));
    }
    let v = blocking(move || {
        let start = match q.path.filter(|p| !p.trim().is_empty()) {
            Some(p) => std::path::PathBuf::from(p),
            None => dirs::home_dir().unwrap_or_else(|| "/".into()),
        };
        let dir = start.canonicalize()?;
        let mut dirs: Vec<String> = std::fs::read_dir(&dir)?
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.'))
            .collect();
        dirs.sort_by_key(|d| d.to_lowercase());
        Ok(json!({
            "path": dir.display().to_string(),
            "parent": dir.parent().map(|p| p.display().to_string()),
            "dirs": dirs,
            "isCollection": dir.join(postbote_core::model::MANIFEST).exists(),
            "sep": std::path::MAIN_SEPARATOR.to_string(),
        }))
    })
    .await?;
    Ok(Json(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_roundtrip_strips_root_folder() {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("my-api/postbote.yaml", o).unwrap();
        w.write_all(b"name: x\n").unwrap();
        w.start_file("my-api/requests/a.req.yaml", o).unwrap();
        w.write_all(b"name: a\n").unwrap();
        w.start_file("../evil", o).unwrap();
        w.write_all(b"x").unwrap();
        let bytes = w.finish().unwrap().into_inner();
        let (files, skipped) = unzip(&bytes).unwrap();
        assert!(files.contains_key("postbote.yaml") && files.contains_key("requests/a.req.yaml"), "{files:?}");
        assert_eq!(skipped, vec!["../evil"]);
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("My API / v2"), "my-api-v2");
        assert_eq!(slug("../.."), "collection");
    }
}
