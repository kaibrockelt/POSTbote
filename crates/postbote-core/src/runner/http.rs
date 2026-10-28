//! Outgoing HTTP. Blocking on purpose: a run (scripts + requests) executes on
//! one dedicated thread, which keeps the QuickJS integration simple.

use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::blocking::{Client, multipart};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::Policy;

use super::Response;
use crate::model::Settings;

pub struct OutReq {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: OutBody,
}

pub enum OutBody {
    None,
    Raw(String),
    Form(Vec<(String, String)>),
    Multipart(Vec<Part>),
}

pub struct Part {
    pub name: String,
    pub value: String,
    /// (file name, content) for file fields
    pub file: Option<(String, String)>,
}

pub struct Http {
    client: Client,
    max_body: usize,
    deny_private: bool,
}

impl Http {
    pub fn new(settings: &Settings, deny_private: bool, max_body: usize, jar: Arc<CookieJar>) -> anyhow::Result<Self> {
        let follow = settings.follow_redirects();
        let policy = Policy::custom(move |attempt| {
            if !follow {
                attempt.stop()
            } else if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if deny_private && url_is_private_literal(attempt.url()) {
                attempt.error("redirect to a private address is blocked by server policy")
            } else {
                attempt.follow()
            }
        });
        let mut b = Client::builder()
            .timeout(Duration::from_millis(settings.timeout_ms()))
            .cookie_provider(jar)
            .redirect(policy)
            .user_agent(concat!("postbote/", env!("CARGO_PKG_VERSION")))
            .tls_danger_accept_invalid_certs(!settings.verify_tls());
        if deny_private {
            b = b.dns_resolver(Arc::new(PublicOnlyResolver)).no_proxy();
        }
        Ok(Self { client: b.build()?, max_body, deny_private })
    }

    pub fn send(&self, r: &OutReq) -> Result<Response, String> {
        let method = reqwest::Method::from_bytes(r.method.as_bytes()).map_err(|_| format!("invalid method {:?}", r.method))?;
        let url = url::Url::parse(&r.url).map_err(|e| format!("invalid URL {:?}: {e}", r.url))?;
        if self.deny_private && url_is_private_literal(&url) {
            return Err("requests to private/loopback addresses are blocked by server policy".into());
        }
        let mut rb = self.client.request(method, url);
        for (k, v) in &r.headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        rb = match &r.body {
            OutBody::None => rb,
            OutBody::Raw(s) => rb.body(s.clone()),
            OutBody::Form(fields) => rb.form(fields),
            OutBody::Multipart(parts) => {
                let mut form = multipart::Form::new();
                for p in parts {
                    form = match &p.file {
                        Some((fname, content)) => {
                            form.part(p.name.clone(), multipart::Part::bytes(content.clone().into_bytes()).file_name(fname.clone()))
                        }
                        None => form.text(p.name.clone(), p.value.clone()),
                    };
                }
                rb.multipart(form)
            }
        };
        let start = Instant::now();
        let resp = rb.send().map_err(|e| error_chain(&e))?;
        let status = resp.status();
        let proto = format!("{:?}", resp.version());
        let headers = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
            .collect();
        let mut buf = Vec::new();
        resp.take(self.max_body as u64 + 1).read_to_end(&mut buf).map_err(|e| format!("reading response: {e}"))?;
        let time_ms = start.elapsed().as_millis() as u64;
        let truncated = buf.len() > self.max_body;
        buf.truncate(self.max_body);
        let size = buf.len() as u64;
        let (body, encoding) = match String::from_utf8(buf) {
            Ok(s) => (s, String::new()),
            Err(e) => (base64::engine::general_purpose::STANDARD.encode(e.as_bytes()), "base64".to_string()),
        };
        Ok(Response {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            proto,
            headers,
            body,
            encoding,
            truncated,
            size,
            time_ms,
        })
    }
}

fn error_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(x) = src {
        let m = x.to_string();
        if !s.contains(&m) {
            s.push_str(": ");
            s.push_str(&m);
        }
        src = x.source();
    }
    s
}

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 carrier-grade NAT
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let s = v6.segments();
            v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
    }
}

fn url_is_private_literal(u: &url::Url) -> bool {
    match u.host() {
        Some(url::Host::Ipv4(ip)) => is_private(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_private(IpAddr::V6(ip)),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost") || d.ends_with(".localhost"),
        None => true,
    }
}

/// DNS resolver used in server mode with --deny-private-networks: only
/// public addresses are handed to the connector.
struct PublicOnlyResolver;

impl Resolve for PublicOnlyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let all: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let public: Vec<SocketAddr> = all.into_iter().filter(|a| !is_private(a.ip())).collect();
            if public.is_empty() {
                return Err(format!("{host} resolves only to private addresses (blocked by server policy)").into());
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

// ---------------------------------------------------------------- cookie jar

/// Cookies kept across runs, per collection and environment (stored by the
/// runner in `.cookies/<env>.json`). Session cookies are kept as well, so a
/// login survives until the jar is cleared.
pub struct CookieJar {
    store: std::sync::Mutex<cookie_store::CookieStore>,
    dirty: std::sync::atomic::AtomicBool,
}

impl CookieJar {
    pub fn load(json: &str) -> Self {
        let store = cookie_store::serde::json::load_all(json.as_bytes()).unwrap_or_default();
        Self { store: std::sync::Mutex::new(store), dirty: false.into() }
    }

    pub fn to_json(&self) -> String {
        let store = self.store.lock().unwrap();
        let mut out = Vec::new();
        // expired cookies are dropped, session cookies kept
        let mut live = cookie_store::CookieStore::default();
        for c in store.iter_unexpired() {
            if let Ok(url) = url::Url::parse(&format!("https://{}{}", cookie_host(c), c.path.as_ref())) {
                let _ = live.insert_raw(c, &url);
            }
        }
        let _ = cookie_store::serde::json::save_incl_expired_and_nonpersistent(&live, &mut out);
        String::from_utf8(out).unwrap_or_default()
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Value of the first unexpired cookie with this name (for `url` if given).
    pub fn get(&self, name: &str, url: Option<&url::Url>) -> Option<String> {
        let store = self.store.lock().unwrap();
        match url {
            Some(u) => store.matches(u).into_iter().find(|c| c.name() == name).map(|c| c.value().to_string()),
            None => store.iter_unexpired().find(|c| c.name() == name).map(|c| c.value().to_string()),
        }
    }

    pub fn all(&self) -> Vec<serde_json::Value> {
        let store = self.store.lock().unwrap();
        store
            .iter_unexpired()
            .map(|c| serde_json::json!({ "name": c.name(), "value": c.value(), "domain": cookie_host(c), "path": c.path.as_ref() }))
            .collect()
    }

    pub fn set(&self, name: &str, value: &str, url: &url::Url) -> Result<(), String> {
        let raw = cookie_store::RawCookie::new(name.to_string(), value.to_string());
        self.store.lock().unwrap().insert_raw(&raw, url).map_err(|e| e.to_string())?;
        self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub fn clear(&self) {
        self.store.lock().unwrap().clear();
        self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

fn cookie_host(c: &cookie_store::Cookie) -> String {
    match &c.domain {
        cookie_store::CookieDomain::HostOnly(h) | cookie_store::CookieDomain::Suffix(h) => h.clone(),
        _ => String::new(),
    }
}

impl reqwest::cookie::CookieStore for CookieJar {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &reqwest::header::HeaderValue>, url: &url::Url) {
        let cookies: Vec<_> = headers
            .filter_map(|h| h.to_str().ok())
            .filter_map(|s| cookie_store::RawCookie::parse(s.to_string()).ok())
            .collect();
        if cookies.is_empty() {
            return;
        }
        self.store.lock().unwrap().store_response_cookies(cookies.into_iter(), url);
        self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn cookies(&self, url: &url::Url) -> Option<reqwest::header::HeaderValue> {
        let store = self.store.lock().unwrap();
        let s = store.get_request_values(url).map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ");
        if s.is_empty() { None } else { reqwest::header::HeaderValue::from_str(&s).ok() }
    }
}
