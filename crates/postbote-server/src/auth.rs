//! Authentication: local token, signed session cookies, users file,
//! reverse-proxy header and a limit for failed sign-ins.

use std::collections::{BTreeMap, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use axum::extract::FromRequestParts;
use axum::http::{HeaderMap, StatusCode};
use axum::http::request::Parts;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::{AppState, AuthMode, Mode};

pub const TOKEN_COOKIE: &str = "postbote_token";
pub const SESSION_COOKIE: &str = "postbote_session";
const SESSION_DAYS: u64 = 14;

pub fn load_or_create_secret(data_dir: &Path) -> anyhow::Result<Vec<u8>> {
    std::fs::create_dir_all(data_dir)?;
    let p = data_dir.join("secret.key");
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(b) = hex::decode(s.trim()) {
            if b.len() >= 32 {
                return Ok(b);
            }
        }
    }
    let b = rand::random::<[u8; 32]>().to_vec();
    std::fs::write(&p, hex::encode(&b))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(b)
}

pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(axum::http::header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|c| {
        let (k, v) = c.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn sign(secret: &[u8], msg: &str) -> String {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("any key length");
    m.update(msg.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

/// Ties a session to the user's current password hash: changing the
/// password (or removing the user) ends all their sessions.
fn password_stamp(secret: &[u8], hash: &str) -> String {
    sign(secret, &format!("pw.{hash}"))[..16].to_string()
}

pub fn make_session(secret: &[u8], user: &str, hash: &str) -> String {
    let u = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(user);
    let msg = format!("{u}.{}.{}", now() + SESSION_DAYS * 86400, password_stamp(secret, hash));
    format!("{msg}.{}", sign(secret, &msg))
}

/// The user of a valid session whose password hash is still `hash_of(user)`.
pub fn verify_session(secret: &[u8], value: &str, hash_of: impl FnOnce(&str) -> Option<String>) -> Option<String> {
    let (msg, sig) = value.rsplit_once('.')?;
    let expected = sign(secret, msg);
    if !constant_eq(expected.as_bytes(), sig.as_bytes()) {
        return None;
    }
    let mut parts = msg.split('.');
    let (u, exp, stamp) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || exp.parse::<u64>().ok()? < now() {
        return None;
    }
    let user = String::from_utf8(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(u).ok()?).ok()?;
    let hash = hash_of(&user)?;
    constant_eq(password_stamp(secret, &hash).as_bytes(), stamp.as_bytes()).then_some(user)
}

pub fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn session_cookie(value: &str, max_age: u64, secure: bool) -> String {
    format!(
        "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

pub fn session_max_age() -> u64 {
    SESSION_DAYS * 86400
}

/// The authenticated user of a request, if any.
pub fn current_user(state: &AppState, headers: &HeaderMap) -> Option<String> {
    match &state.cfg.mode {
        Mode::Local { token } => {
            let t = cookie(headers, TOKEN_COOKIE)?;
            constant_eq(t.as_bytes(), token.as_bytes()).then(|| "local".to_string())
        }
        Mode::Server { auth, .. } => match auth {
            AuthMode::None => Some("default".into()),
            AuthMode::Header(h) => headers.get(h).and_then(|v| v.to_str().ok()).map(str::trim).filter(|s| !s.is_empty()).map(String::from),
            AuthMode::Local => {
                let Mode::Server { data_dir, .. } = &state.cfg.mode else { return None };
                verify_session(&state.secret, &cookie(headers, SESSION_COOKIE)?, |u| state.users.hash(data_dir, u))
            }
        },
    }
}

/// Extractor for handlers that need a logged-in user.
pub struct User(pub String);

impl FromRequestParts<Arc<AppState>> for User {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self, Self::Rejection> {
        current_user(state, &parts.headers).map(User).ok_or((StatusCode::UNAUTHORIZED, "not authenticated"))
    }
}

/// The client's address (for the sign-in limit); `None` without connect info.
pub struct PeerIp(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for PeerIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(PeerIp(parts.extensions.get::<axum::extract::ConnectInfo<SocketAddr>>().map(|c| c.0.ip())))
    }
}

/// Directory name for a user: readable when safe, hashed otherwise.
pub fn user_dir_name(user: &str) -> String {
    let safe = !user.is_empty()
        && user.len() <= 64
        && !user.starts_with('.')
        && user.chars().all(|c| c.is_ascii_alphanumeric() || "._@-".contains(c));
    if safe {
        user.to_string()
    } else {
        use sha2::Digest;
        format!("u-{}", &hex::encode(Sha256::digest(user.as_bytes()))[..24])
    }
}

// ---------------------------------------------------------------- users file

pub fn users_file(data_dir: &Path) -> PathBuf {
    data_dir.join("users.json")
}

pub fn load_users(data_dir: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    match std::fs::read_to_string(users_file(data_dir)) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.into()),
    }
}

pub fn save_users(data_dir: &Path, users: &BTreeMap<String, String>) -> anyhow::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let p = users_file(data_dir);
    std::fs::write(&p, serde_json::to_string_pretty(users)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// users.json, re-read when it changes (the `user` CLI edits it, also from
/// another container) and at least every few seconds.
#[derive(Default)]
pub struct UsersCache(Mutex<Option<(Option<SystemTime>, Instant, BTreeMap<String, String>)>>);

impl UsersCache {
    pub fn hash(&self, data_dir: &Path, user: &str) -> Option<String> {
        let mtime = std::fs::metadata(users_file(data_dir)).and_then(|m| m.modified()).ok();
        let mut c = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = matches!(&*c, Some((m, at, _)) if *m == mtime && at.elapsed().as_secs() < 5);
        if !fresh {
            *c = Some((mtime, Instant::now(), load_users(data_dir).unwrap_or_default()));
        }
        c.as_ref().and_then(|(_, _, users)| users.get(user).cloned())
    }

    pub fn forget(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Failed sign-ins per user name and per client address: a few attempts are
/// free, then each further failure locks the key for longer (up to 15 min).
#[derive(Default)]
pub struct LoginLimiter(Mutex<HashMap<String, (u32, u64)>>);

const FREE_ATTEMPTS_USER: u32 = 5;
const FREE_ATTEMPTS_IP: u32 = 20;
const MAX_LOCK_SECS: u64 = 15 * 60;
/// failures older than this are forgotten
const FORGET_SECS: u64 = 3600;

fn keys(user: &str, ip: Option<IpAddr>) -> Vec<(String, u32)> {
    let mut k = vec![(format!("u:{}", user.to_lowercase()), FREE_ATTEMPTS_USER)];
    if let Some(ip) = ip {
        k.push((format!("ip:{ip}"), FREE_ATTEMPTS_IP));
    }
    k
}

fn lock_secs(failures: u32, free: u32) -> u64 {
    if failures < free { 0 } else { (30u64 << (failures - free).min(10)).min(MAX_LOCK_SECS) }
}

impl LoginLimiter {
    /// Seconds until the next attempt is allowed (0 = now).
    pub fn wait(&self, user: &str, ip: Option<IpAddr>) -> u64 {
        let m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let t = now();
        keys(user, ip)
            .iter()
            .filter_map(|(k, free)| m.get(k).map(|(n, last)| (last + lock_secs(*n, *free)).saturating_sub(t)))
            .max()
            .unwrap_or(0)
    }

    pub fn failed(&self, user: &str, ip: Option<IpAddr>) {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let t = now();
        if m.len() > 10_000 {
            m.retain(|_, (_, last)| t - *last < FORGET_SECS);
        }
        for (k, _) in keys(user, ip) {
            let e = m.entry(k).or_insert((0, t));
            if t - e.1 > FORGET_SECS {
                e.0 = 0;
            }
            *e = (e.0 + 1, t);
        }
    }

    /// A successful sign-in clears the user's failures (not the address's).
    pub fn succeeded(&self, user: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&format!("u:{}", user.to_lowercase()));
    }
}

/// The user's hash if `password` is right.
pub fn check_password(data_dir: &Path, user: &str, password: &str) -> Option<String> {
    let Ok(users) = load_users(data_dir) else { return None };
    match users.get(user) {
        Some(hash) => bcrypt::verify(password, hash).unwrap_or(false).then(|| hash.clone()),
        None => {
            // same cost as a real check, so user names cannot be probed by timing
            let _ = bcrypt::verify(password, "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5dKpTvlBvxUSa4KiWB0RZRrBzLyXQwW");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";

    #[test]
    fn session_roundtrip() {
        let s = make_session(KEY, "alice@example.org", "hash1");
        let same = |_: &str| Some("hash1".to_string());
        assert_eq!(verify_session(KEY, &s, same).as_deref(), Some("alice@example.org"));
        assert!(verify_session(b"another-secret-another-secret-xx", &s, same).is_none());
        let tampered = s.replacen('Y', "Z", 1);
        assert!(tampered == s || verify_session(KEY, &tampered, same).is_none());
    }

    #[test]
    fn password_change_or_removal_ends_sessions() {
        let s = make_session(KEY, "alice", "old-hash");
        assert!(verify_session(KEY, &s, |_| Some("new-hash".into())).is_none());
        assert!(verify_session(KEY, &s, |_| None).is_none());
        // sessions from before the stamp existed are invalid
        let u = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("alice");
        let msg = format!("{u}.{}", now() + 3600);
        let legacy = format!("{msg}.{}", sign(KEY, &msg));
        assert!(verify_session(KEY, &legacy, |_| Some("old-hash".into())).is_none());
    }

    #[test]
    fn login_limiter_locks_after_free_attempts() {
        let l = LoginLimiter::default();
        let ip: Option<IpAddr> = Some("10.0.0.1".parse().unwrap());
        for _ in 0..FREE_ATTEMPTS_USER - 1 {
            l.failed("Alice", ip);
            assert_eq!(l.wait("alice", ip), 0);
        }
        l.failed("alice", ip);
        let w = l.wait("ALICE", None);
        assert!(w > 0 && w <= 30, "{w}");
        // another user from the same address is not locked yet
        assert_eq!(l.wait("bob", ip), 0);
        l.succeeded("alice");
        assert_eq!(l.wait("alice", None), 0);
        assert_eq!(lock_secs(FREE_ATTEMPTS_USER + 20, FREE_ATTEMPTS_USER), MAX_LOCK_SECS);
    }

    #[test]
    fn user_dirs() {
        assert_eq!(user_dir_name("alice"), "alice");
        assert!(user_dir_name("../etc").starts_with("u-"));
        assert!(user_dir_name("Ünïcode").starts_with("u-"));
    }
}
