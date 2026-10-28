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

#[derive(Clone)]
pub struct Http {
    client: Client,
    max_body: usize,
    deny_private: bool,
}

impl Http {
    pub fn new(settings: &Settings, deny_private: bool, max_body: usize) -> anyhow::Result<Self> {
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
            .cookie_store(true)
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
