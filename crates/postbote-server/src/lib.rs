//! HTTP API + embedded web UI.
//!
//! Two modes share one code base:
//! * **local** – single user on 127.0.0.1 (desktop app / `postbote local`).
//!   Collections are plain folders anywhere on disk; access is protected by a
//!   random per-start token.
//! * **server** – team instance (Docker). Every user is isolated. By default
//!   collections stay in the user's browser; storing them on the server is an
//!   explicit per-collection opt-in.

mod api;
mod assets;
pub mod auth;
mod workspaces;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use tokio::net::TcpListener;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthMode {
    /// no login, everybody is the user "default" (single-user or trusted LAN)
    None,
    /// users from `<data>/users.json`, managed with `postbote user add`
    Local,
    /// trust a header set by an authenticating reverse proxy
    Header(String),
}

#[derive(Debug, Clone)]
pub enum Mode {
    Local { token: String },
    Server { data_dir: PathBuf, auth: AuthMode, allow_server_storage: bool },
}

#[derive(Debug, Clone)]
pub struct Config {
    pub mode: Mode,
    pub deny_private_networks: bool,
    pub max_run_seconds: u64,
    pub memory_limit_mb: usize,
    pub max_concurrent_runs: usize,
    /// set the Secure flag on cookies (server behind TLS)
    pub secure_cookies: bool,
}

pub struct AppState {
    pub cfg: Config,
    pub secret: Vec<u8>,
    pub runs: tokio::sync::Semaphore,
    pub registry_lock: tokio::sync::Mutex<()>,
}

impl AppState {
    pub fn is_local(&self) -> bool {
        matches!(self.cfg.mode, Mode::Local { .. })
    }
}

pub fn router(cfg: Config) -> anyhow::Result<Router> {
    let secret = match &cfg.mode {
        Mode::Local { .. } => rand::random::<[u8; 32]>().to_vec(),
        Mode::Server { data_dir, .. } => auth::load_or_create_secret(data_dir)?,
    };
    let state = Arc::new(AppState {
        runs: tokio::sync::Semaphore::new(cfg.max_concurrent_runs.max(1)),
        cfg,
        secret,
        registry_lock: tokio::sync::Mutex::new(()),
    });
    Ok(api::routes(state.clone()).merge(assets::routes()).layer(axum::middleware::from_fn_with_state(state.clone(), api::entry)).with_state(state))
}

pub fn random_token() -> String {
    hex::encode(rand::random::<[u8; 24]>())
}

/// Starts a local-mode server on 127.0.0.1 and returns the URL to open
/// (including the one-time token).
pub async fn start_local(port: u16) -> anyhow::Result<(String, tokio::task::JoinHandle<()>)> {
    let token = random_token();
    let cfg = Config {
        mode: Mode::Local { token: token.clone() },
        deny_private_networks: false,
        max_run_seconds: 3600,
        memory_limit_mb: 512,
        max_concurrent_runs: 16,
        secure_cookies: false,
    };
    let app = router(cfg)?;
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
    let addr = listener.local_addr()?;
    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("server error: {e}");
        }
    });
    Ok((format!("http://127.0.0.1:{}/?token={token}", addr.port()), handle))
}
