use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use postbote_core::fs::{DiskFs, Fs};
use postbote_core::runner::{self, RequestResult, RunOptions, RunOutput, Target};
use postbote_server::{AuthMode, Config, Mode};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "postbote", version, about = "Offline-first API client: collections as text files, no cloud.")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Start the single-user app on 127.0.0.1 and open it in the browser (default)
    Local {
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// do not open a browser
        #[arg(long)]
        no_open: bool,
    },
    /// Run the multi-user team server (e.g. in Docker)
    Serve {
        #[arg(long, env = "POSTBOTE_ADDR", default_value = "0.0.0.0:8080")]
        addr: String,
        #[arg(long, env = "POSTBOTE_DATA", default_value = "./data")]
        data: PathBuf,
        /// none | local | header
        #[arg(long, env = "POSTBOTE_AUTH", default_value = "local")]
        auth: String,
        /// header carrying the user name when --auth header (set by your auth proxy)
        #[arg(long, env = "POSTBOTE_AUTH_HEADER", default_value = "X-Forwarded-User")]
        auth_header: String,
        /// disable the opt-in server-side storage of collections entirely
        #[arg(long, env = "POSTBOTE_NO_SERVER_STORAGE")]
        no_server_storage: bool,
        /// block requests to private, loopback and link-local addresses (SSRF protection)
        #[arg(long, env = "POSTBOTE_DENY_PRIVATE_NETWORKS")]
        deny_private_networks: bool,
        #[arg(long, env = "POSTBOTE_MAX_RUN_SECONDS", default_value_t = 600)]
        max_run_seconds: u64,
        /// memory limit of the script engine per run
        #[arg(long, env = "POSTBOTE_SCRIPT_MEMORY_MB", default_value_t = 128)]
        script_memory_mb: usize,
        #[arg(long, env = "POSTBOTE_MAX_CONCURRENT_RUNS", default_value_t = 32)]
        max_concurrent_runs: usize,
        /// mark cookies as Secure (enable when served via HTTPS)
        #[arg(long, env = "POSTBOTE_SECURE_COOKIES")]
        secure_cookies: bool,
    },
    /// Run a request or runner from the command line, e.g. in CI
    Run {
        /// collection folder (contains postbote.yaml)
        dir: PathBuf,
        /// request (*.req.yaml) or runner (*.runner.yaml), relative to the collection
        path: String,
        /// environment name: environments/<name>.env.pub overlaid by environments/<name>.env
        #[arg(long, short)]
        env: Option<String>,
        /// print the full result as JSON
        #[arg(long)]
        json: bool,
    },
    /// Manage the users of a team server started with --auth local
    User {
        #[command(subcommand)]
        action: UserCmd,
        #[arg(long, env = "POSTBOTE_DATA", default_value = "./data", global = true)]
        data: PathBuf,
    },
}

#[derive(Subcommand)]
enum UserCmd {
    /// Add a user or change their password
    Add {
        name: String,
        /// read the password from stdin instead of prompting (for provisioning scripts)
        #[arg(long)]
        password_stdin: bool,
    },
    /// Remove a user (their server-stored collections stay on disk)
    Remove { name: String },
    /// List users
    List,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd.unwrap_or(Cmd::Local { port: 0, no_open: false }) {
        Cmd::Local { port, no_open } => {
            let (url, handle) = postbote_server::start_local(port).await?;
            println!("postbote is running at {url}");
            if !no_open {
                let _ = open::that(&url);
            }
            tokio::select! {
                _ = shutdown_signal() => {}
                _ = handle => {}
            }
            Ok(())
        }
        Cmd::Serve { addr, data, auth, auth_header, no_server_storage, deny_private_networks, max_run_seconds, script_memory_mb, max_concurrent_runs, secure_cookies } => {
            let auth = match auth.as_str() {
                "none" => AuthMode::None,
                "local" => AuthMode::Local,
                "header" => AuthMode::Header(auth_header.to_lowercase()),
                other => bail!("unknown --auth {other:?} (none | local | header)"),
            };
            if auth == AuthMode::Local && postbote_server::auth::load_users(&data)?.is_empty() {
                eprintln!("warning: no users yet. Create one with: postbote user add <name> --data {}", data.display());
            }
            if auth == AuthMode::None {
                eprintln!("warning: --auth none: everybody shares the user \"default\"");
            }
            let cfg = Config {
                mode: Mode::Server { data_dir: data, auth, allow_server_storage: !no_server_storage },
                deny_private_networks,
                max_run_seconds,
                memory_limit_mb: script_memory_mb,
                max_concurrent_runs,
                secure_cookies,
            };
            let app = postbote_server::router(cfg)?;
            let listener = tokio::net::TcpListener::bind(&addr).await.with_context(|| format!("bind {addr}"))?;
            println!("postbote team server listening on http://{}", listener.local_addr()?);
            axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
            Ok(())
        }
        Cmd::Run { dir, path, env, json } => {
            let out = tokio::task::spawn_blocking(move || run_cli(dir, path, env)).await??;
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                print_output(&out);
            }
            std::process::exit(if out.failed() { 1 } else { 0 });
        }
        Cmd::User { action, data } => user_cmd(action, &data),
    }
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
}

fn run_cli(dir: PathBuf, path: String, env: Option<String>) -> Result<RunOutput> {
    let fs = DiskFs::open(&dir)?;
    let env = match env {
        None => None,
        Some(e) => {
            // accept a name or a file path (environments/staging.env[.pub])
            let name = e.rsplit('/').next().unwrap_or(&e).trim_end_matches(".pub").trim_end_matches(".env").to_string();
            let exists = [postbote_core::model::env_public_path(&name), postbote_core::model::env_private_path(&name)]
                .iter()
                .any(|p| fs.read(p).is_ok());
            if !exists {
                bail!("environment {name:?} not found");
            }
            Some(name)
        }
    };
    let target = if path.ends_with(postbote_core::model::RUNNER_EXT) {
        Target::Workflow(path)
    } else if path.ends_with(postbote_core::model::GRAPH_EXT) {
        Target::Graph(path, None)
    } else {
        Target::Request(path)
    };
    Ok(runner::run(Box::new(fs), target, RunOptions { env, ..Default::default() }))
}

fn mark(ok: bool) -> &'static str {
    if ok { "✔" } else { "✘" }
}

fn print_request(r: &RequestResult, indent: &str) {
    let status = match (&r.response, &r.error) {
        (Some(res), _) => format!("{} {} ({} ms)", res.status, res.status_text, res.time_ms),
        (None, Some(e)) => format!("error: {e}"),
        _ => String::new(),
    };
    let target = r.request.as_ref().map(|q| format!("{} {}", q.method, q.url)).unwrap_or_default();
    println!("{indent}{} {}  {target}  → {status}", mark(!r.failed()), r.name);
    for t in &r.tests {
        println!("{indent}    {} {}{}", mark(t.passed), t.name, t.error.as_ref().map(|e| format!(" — {e}")).unwrap_or_default());
    }
    for e in &r.script_errors {
        println!("{indent}    ✘ {e}");
    }
    for l in &r.logs {
        println!("{indent}    [{}] {}", l.level, l.message.replace('\n', &format!("\n{indent}    ")));
    }
}

fn print_output(out: &RunOutput) {
    if let Some(r) = &out.request {
        print_request(r, "");
    }
    if let Some(w) = &out.workflow {
        println!("runner {}", w.name);
        for l in &w.logs {
            println!("  [{}] {}", l.level, l.message);
        }
        for it in &w.iterations {
            println!("  iteration {}", it.index + 1);
            for s in &it.steps {
                match &s.result {
                    Some(r) => print_request(r, "    "),
                    None => println!("    - {} skipped ({})", s.step, s.reason.clone().unwrap_or_default()),
                }
            }
        }
        for t in &w.tests {
            println!("  {} {}{}", mark(t.passed), t.name, t.error.as_ref().map(|e| format!(" — {e}")).unwrap_or_default());
        }
        for e in &w.script_errors {
            println!("  ✘ {e}");
        }
        if let Some(s) = &w.stopped {
            println!("  stopped: {s}");
        }
        if let Some(e) = &w.error {
            println!("  error: {e}");
        }
        println!("tests: {} passed, {} failed ({} ms)", w.passed, w.failed, w.duration_ms);
    }
    if let Some(g) = &out.graph {
        println!("workflow {}", g.name);
        for s in &g.steps {
            let what = if s.name.is_empty() { format!("{} {}", s.kind, s.node) } else { s.name.clone() };
            println!("  {} {what} → {}", mark(s.error.is_none()), s.port);
            if let Some(r) = &s.request {
                print_request(r, "    ");
            }
            if let Some(e) = &s.error {
                println!("    {e}");
            }
        }
        for l in &g.logs {
            println!("  [{}] {}", l.level, l.message);
        }
        match (&g.error, &g.result) {
            (Some(e), _) => println!("  error: {e}"),
            (None, Some(v)) => println!("  result: {v}"),
            _ => {}
        }
        println!("({} ms)", g.duration_ms);
    }
    if let Some(e) = &out.error {
        println!("error: {e}");
    }
    for (p, c) in &out.changed_files {
        println!("{} {p}", if c.is_some() { "wrote" } else { "deleted" });
    }
}

fn user_cmd(action: UserCmd, data: &std::path::Path) -> Result<()> {
    use postbote_server::auth::{load_users, save_users};
    let mut users = load_users(data)?;
    match action {
        UserCmd::Add { name, password_stdin } => {
            let name = name.trim().to_string();
            if name.is_empty() {
                bail!("empty user name");
            }
            let pw = if password_stdin {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line)?;
                line.trim_end_matches(['\r', '\n']).to_string()
            } else {
                rpassword::prompt_password(format!("Password for {name}: "))?
            };
            if pw.len() < 8 {
                bail!("password must have at least 8 characters");
            }
            if !password_stdin && rpassword::prompt_password("Repeat password: ")? != pw {
                bail!("passwords do not match");
            }
            users.insert(name.clone(), bcrypt::hash(pw, 12)?);
            save_users(data, &users)?;
            println!("saved user {name}");
        }
        UserCmd::Remove { name } => {
            if users.remove(&name).is_none() {
                bail!("no such user {name:?}");
            }
            save_users(data, &users)?;
            println!("removed user {name}");
        }
        UserCmd::List => {
            for u in users.keys() {
                println!("{u}");
            }
        }
    }
    Ok(())
}
