//! Authentication: local token, signed session cookies, users file and
//! reverse-proxy header.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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

pub fn make_session(secret: &[u8], user: &str) -> String {
    let u = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(user);
    let msg = format!("{u}.{}", now() + SESSION_DAYS * 86400);
    format!("{msg}.{}", sign(secret, &msg))
}

pub fn verify_session(secret: &[u8], value: &str) -> Option<String> {
    let (msg, sig) = value.rsplit_once('.')?;
    let expected = sign(secret, msg);
    if !constant_eq(expected.as_bytes(), sig.as_bytes()) {
        return None;
    }
    let (u, exp) = msg.split_once('.')?;
    if exp.parse::<u64>().ok()? < now() {
        return None;
    }
    String::from_utf8(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(u).ok()?).ok()
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
            AuthMode::Local => verify_session(&state.secret, &cookie(headers, SESSION_COOKIE)?),
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

pub fn check_password(data_dir: &Path, user: &str, password: &str) -> bool {
    let Ok(users) = load_users(data_dir) else { return false };
    match users.get(user) {
        Some(hash) => bcrypt::verify(password, hash).unwrap_or(false),
        None => {
            // same cost as a real check, so user names cannot be probed by timing
            let _ = bcrypt::verify(password, "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5dKpTvlBvxUSa4KiWB0RZRrBzLyXQwW");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_roundtrip() {
        let s = make_session(b"0123456789abcdef0123456789abcdef", "alice@example.org");
        assert_eq!(verify_session(b"0123456789abcdef0123456789abcdef", &s).as_deref(), Some("alice@example.org"));
        assert!(verify_session(b"another-secret-another-secret-xx", &s).is_none());
        let tampered = s.replacen('Y', "Z", 1);
        assert!(tampered == s || verify_session(b"0123456789abcdef0123456789abcdef", &tampered).is_none());
    }

    #[test]
    fn user_dirs() {
        assert_eq!(user_dir_name("alice"), "alice");
        assert!(user_dir_name("../etc").starts_with("u-"));
        assert!(user_dir_name("Ünïcode").starts_with("u-"));
    }
}
