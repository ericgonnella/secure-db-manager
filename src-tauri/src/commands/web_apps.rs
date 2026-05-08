//! Static web app hosting via `nginx:alpine`.
//!
//! Each web app is a long-running nginx container joined to the shared
//! `baseport-net` Docker network so it can `proxy_pass` requests to linked DB
//! instances by container name. Two file-serving modes:
//!
//! * `dev`    — bind-mount a host folder read-only at `/var/www/html`. Edits
//!              to the source files are visible immediately (no reload).
//! * `deploy` — mount a named Docker volume at `/var/www/html` and ship files
//!              into it via `docker cp`. Survives container recreation.
//!
//! Linked PocketBase / ClickHouse instances get auto-generated `proxy_pass`
//! blocks (`/pb/`, `/ch/`) so browser apps can call DB APIs without CORS.

use crate::commands::instances::uuid_v4;
use crate::local_store::{
    append_audit_event, load_store, save_store, AuditEvent, LocalInstance, WebApp,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

// ── Helpers ────────────────────────────────────────────────────────────────

fn docker_mode(app: &AppHandle) -> crate::commands::docker::DockerMode {
    let state = app.state::<crate::AppState>();
    let mode = state.docker_mode.lock().unwrap().clone();
    mode
}

fn docker_cmd(app: &AppHandle) -> Command {
    crate::commands::docker::build_docker_command(&docker_mode(app))
}

fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn web_app_root(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let mut p = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;
    p.push("web_apps");
    p.push(id);
    Ok(p)
}

/// Convert a Windows path like `C:\Users\me\dist` into a form Docker on
/// the current mode (native vs WSL2) accepts as a bind mount source.
/// Native Docker on Windows accepts `C:\Users\me\dist` directly. WSL2 docker
/// requires the wslpath-translated form (`/mnt/c/Users/me/dist`).
fn host_path_for_mount(app: &AppHandle, raw: &str) -> Result<String, String> {
    let mode = docker_mode(app);
    if matches!(mode, crate::commands::docker::DockerMode::Wsl2) {
        // Use `wsl wslpath -a -u <path>` for translation.
        let out = Command::new("wsl")
            .args(["wslpath", "-a", "-u", raw])
            .output()
            .map_err(|e| format!("wslpath failed: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "wslpath could not translate {raw}: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Ok(raw.to_string())
    }
}

// ── nginx config generation ────────────────────────────────────────────────

/// Generate the **main** nginx.conf (mounted at /etc/nginx/nginx.conf).
///
/// The only change from the nginx:alpine default is `user root;` so that
/// worker processes can read bind-mounted files from Windows/WSL2 paths
/// regardless of file ownership inside the container.
pub fn generate_main_nginx_conf() -> String {
    r#"user root;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid       /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include      /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile     on;
    tcp_nopush   on;
    keepalive_timeout 65;
    include /etc/nginx/conf.d/*.conf;
}
"#
    .to_string()
}

/// Generate the per-server nginx.conf (mounted at /etc/nginx/conf.d/default.conf).
///
/// Only the `server` block is needed — the surrounding `http {}` context
/// is provided by the main nginx.conf above.
pub fn generate_nginx_conf(linked: &[LocalInstance]) -> String {
    let mut server = String::new();
    server.push_str("server {\n");
    server.push_str("    listen 80;\n");
    server.push_str("    server_name _;\n");
    server.push_str("    root /var/www/html;\n");
    server.push_str("    index index.html index.htm;\n");
    server.push_str("    autoindex off;\n");
    server.push_str("    sendfile on;\n");
    server.push_str("    tcp_nopush on;\n");
    server.push_str("    gzip on;\n");
    server.push_str("    gzip_vary on;\n");
    server.push_str("    gzip_min_length 1024;\n");
    server.push_str("    gzip_types text/plain text/css application/json application/javascript text/javascript application/wasm image/svg+xml;\n\n");

    // Docker's embedded DNS resolver (127.0.0.11).
    // `valid=30s` re-checks every 30 s; `ipv6=off` avoids AAAA lookup failures
    // on networks that don't expose IPv6.  The resolver directive also enables
    // deferred (request-time) resolution when the upstream is stored in a
    // variable — nginx will start even if linked containers aren't up yet.
    if !linked.is_empty() {
        server.push_str("    resolver 127.0.0.11 valid=30s ipv6=off;\n\n");
    }

    server.push_str("    # Long-cache hashed static assets\n");
    server.push_str("    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|wasm|woff|woff2|ttf|eot)$ {\n");
    server.push_str("        expires 1y;\n");
    server.push_str("        add_header Cache-Control \"public, immutable\";\n");
    server.push_str("        try_files $uri =404;\n");
    server.push_str("    }\n\n");

    // Per-DB proxy blocks (only HTTP-native DBs get proxied)
    for inst in linked {
        match inst.service_type.as_str() {
            "pocketbase" => {
                server.push_str(&format!(
                    "    # → PocketBase ({}) — REST + realtime websockets\n",
                    inst.name
                ));
                // Store hostname in a variable so nginx defers DNS resolution to
                // request time (startup succeeds even if PB container isn't up yet).
                server.push_str(&format!(
                    "    set $pb_upstream_{}  http://{}:8090;\n",
                    inst.container_name, inst.container_name
                ));
                server.push_str("    location /pb/ {\n");
                server.push_str(&format!(
                    "        proxy_pass $pb_upstream_{}/;\n",
                    inst.container_name
                ));
                server.push_str("        proxy_http_version 1.1;\n");
                server.push_str("        proxy_set_header Host $host;\n");
                server.push_str("        proxy_set_header X-Real-IP $remote_addr;\n");
                server.push_str("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n");
                server.push_str("        proxy_set_header X-Forwarded-Proto $scheme;\n");
                server.push_str("        proxy_set_header Upgrade $http_upgrade;\n");
                server.push_str("        proxy_set_header Connection \"upgrade\";\n");
                server.push_str("        proxy_read_timeout 86400;\n");
                server.push_str("    }\n\n");
            }
            "clickhouse" => {
                server.push_str(&format!(
                    "    # → ClickHouse ({}) — HTTP query interface\n",
                    inst.name
                ));
                server.push_str(&format!(
                    "    set $ch_upstream_{}  http://{}:8123;\n",
                    inst.container_name, inst.container_name
                ));
                server.push_str("    location /ch/ {\n");
                server.push_str(&format!(
                    "        proxy_pass $ch_upstream_{}/;\n",
                    inst.container_name
                ));
                server.push_str("        proxy_set_header Host $host;\n");
                server.push_str("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n");
                server.push_str("        proxy_read_timeout 60;\n");
                server.push_str("    }\n\n");
            }
            _ => {}
        }
    }

    // try_files chain:
    //   $uri            – exact file match
    //   $uri.html       – <route>.html from Next.js / Astro static exports
    //   $uri/index.html – directory index (works with trailingSlash: true)
    //   /index.html     – SPA catch-all (serves root index for client-side routing)
    //   =404            – hard 404 if nothing found (prevents misleading 200s)
    server.push_str("    location / {\n");
    server.push_str("        try_files $uri $uri.html $uri/index.html /index.html =404;\n");
    server.push_str("    }\n");
    server.push_str("}\n");
    server
}

// ── Input / output types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateWebAppInput {
    pub name: String,
    pub port: u16,
    /// "dev" | "deploy"
    pub mode: String,
    /// Required for `mode == "dev"` — absolute host path to the project root.
    pub src_path: Option<String>,
    /// Relative output dir inside `src_path` (e.g. "dist", "build", "out").
    /// Empty string means serve `src_path` directly (no build step / static folder).
    #[serde(default)]
    pub build_output_dir: String,
    /// Shell command to run before the container starts (e.g. "pnpm build").
    #[serde(default)]
    pub build_command: Option<String>,
    /// "nginx" (default) | "nodejs"
    #[serde(default = "default_container_type_input")]
    pub container_type: String,
    /// For `container_type = "nodejs"`: command run inside the container to start the app.
    #[serde(default)]
    pub nodejs_start_command: Option<String>,
    /// For `container_type = "nodejs"`: port the app listens on inside the container.
    #[serde(default = "default_nodejs_port_input")]
    pub nodejs_app_port: u16,
    #[serde(default)]
    pub linked_instance_ids: Vec<String>,
    #[serde(default = "default_project_id")]
    pub project_id: String,
}

fn default_project_id() -> String {
    "default".to_string()
}

fn default_container_type_input() -> String {
    "nginx".to_string()
}

fn default_nodejs_port_input() -> u16 {
    3000
}

/// Detect which package manager the project uses, based on lockfile presence.
/// Returns the appropriate install command string.
fn detect_install_command(src_path: &str) -> Option<&'static str> {
    let p = std::path::Path::new(src_path);
    if p.join("pnpm-lock.yaml").exists() {
        return Some("pnpm install");
    }
    if p.join("bun.lockb").exists() || p.join("bun.lock").exists() {
        return Some("bun install");
    }
    if p.join("yarn.lock").exists() {
        return Some("yarn install");
    }
    if p.join("package-lock.json").exists() {
        return Some("npm install");
    }
    if p.join("package.json").exists() {
        return Some("npm install"); // fallback: any project with package.json
    }
    None
}

/// If `node_modules` is absent, auto-detect the package manager and install
/// dependencies before the build runs. Returns `Ok(Some(cmd))` when an
/// install was performed, `Ok(None)` when it was not needed.
fn ensure_dependencies(src_path: &str) -> Result<Option<String>, String> {
    if std::path::Path::new(src_path).join("node_modules").exists() {
        return Ok(None); // nothing to do
    }
    let install_cmd = detect_install_command(src_path).ok_or_else(|| {
        format!("No package.json found in '{}'. Cannot install dependencies.", src_path)
    })?;
    let out = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", install_cmd])
            .current_dir(src_path)
            .output()
    } else {
        Command::new("sh")
            .args(["-c", install_cmd])
            .current_dir(src_path)
            .output()
    };
    match out {
        Ok(o) if o.status.success() => Ok(Some(install_cmd.to_string())),
        Ok(o) => Err(format!(
            "Auto-install ({install_cmd}) failed:\n{}",
            String::from_utf8_lossy(&o.stderr)
        )),
        Err(e) => Err(format!("Failed to launch '{install_cmd}': {e}")),
    }
}

/// Reject control characters, NUL bytes, and excessively long inputs.
/// The build command is intentionally user-supplied and runs through a shell
/// (the user is configuring their own machine), but we still defend against
/// pathological values that could cause crashes, log corruption, or unintended
/// shell behaviour from clipboard / persisted-store tampering.
fn validate_user_shell_command(cmd: &str, label: &str) -> Result<(), String> {
    const MAX_LEN: usize = 4096;
    if cmd.len() > MAX_LEN {
        return Err(format!(
            "{label} is too long ({} bytes; max {MAX_LEN}).",
            cmd.len()
        ));
    }
    if cmd.chars().any(|c| c == '\0' || (c.is_control() && c != '\n' && c != '\r' && c != '\t')) {
        return Err(format!("{label} contains disallowed control characters."));
    }
    Ok(())
}

/// Run a shell build command in the given directory.
/// Uses `cmd /C` on Windows and `sh -c` elsewhere.
fn run_build_command(src_path: &str, cmd: &str) -> Result<String, String> {
    validate_user_shell_command(cmd, "Build command")?;
    let out = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", cmd])
            .current_dir(src_path)
            .output()
    } else {
        Command::new("sh")
            .args(["-c", cmd])
            .current_dir(src_path)
            .output()
    };
    match out {
        Ok(o) if o.status.success() => {
            Ok(String::from_utf8_lossy(&o.stdout).to_string())
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            Err(format!("Build failed:\n{stderr}\n{stdout}"))
        }
        Err(e) => Err(format!("Failed to launch build command: {e}")),
    }
}

#[derive(Debug, Serialize)]
pub struct WebAppConnectionEntry {
    pub instance_id: String,
    pub instance_name: String,
    pub service_type: String,
    pub browser_compatible: bool,
    pub proxy_path: Option<String>,
    pub proxy_url: Option<String>,
    pub sdk_snippet: Option<String>,
    pub direct_uri: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WebAppConnectionInfo {
    pub web_app_url: String,
    pub connections: Vec<WebAppConnectionEntry>,
}

// ── Docker helpers ─────────────────────────────────────────────────────────

fn refresh_status(app: &AppHandle, container: &str) -> String {
    let out = docker_cmd(app)
        .args([
            "inspect",
            "--format={{.State.Status}}",
            container,
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            match s.as_str() {
                "running" => "running".into(),
                "" => "stopped".into(),
                other => other.into(),
            }
        }
        _ => "stopped".into(),
    }
}

fn audit(
    app: &AppHandle,
    web_app: &WebApp,
    action: &str,
    outcome: &str,
    detail: Option<String>,
) {
    append_audit_event(
        app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: action.to_string(),
            instance_id: web_app.id.clone(),
            instance_name: web_app.name.clone(),
            service_type: "webapp".into(),
            environment: "local".into(),
            outcome: outcome.to_string(),
            detail,
        },
    );
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_web_app(
    app: AppHandle,
    input: CreateWebAppInput,
) -> Result<WebApp, String> {
    // ── Validate ───────────────────────────────────────────────────────────
    if input.name.trim().is_empty() {
        return Err("Web app name is required.".into());
    }
    if input.port < 1024 {
        return Err("Port must be 1024 or higher.".into());
    }
    let is_nodejs = input.container_type == "nodejs";
    if is_nodejs {
        match input.src_path.as_deref() {
            Some(p) if !p.trim().is_empty() => {
                let path = PathBuf::from(p);
                if !path.exists() {
                    return Err(format!("Source folder does not exist: {p}"));
                }
                if !path.is_dir() {
                    return Err(format!("Source path is not a directory: {p}"));
                }
            }
            _ => return Err("Node.js container requires a source folder path.".into()),
        }
        if input
            .nodejs_start_command
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            return Err("Node.js container requires a start command.".into());
        }
    } else {
        if input.mode != "dev" && input.mode != "deploy" {
            return Err("Mode must be either 'dev' or 'deploy'.".into());
        }
        if input.mode == "dev" {
            match input.src_path.as_deref() {
                Some(p) if !p.trim().is_empty() => {
                    let path = PathBuf::from(p);
                    if !path.exists() {
                        return Err(format!("Source folder does not exist: {p}"));
                    }
                    if !path.is_dir() {
                        return Err(format!("Source path is not a directory: {p}"));
                    }
                }
                _ => return Err("Dev mode requires a source folder path.".into()),
            }
        }
    }

    let slug = slugify(&input.name);
    if slug.is_empty() {
        return Err("Name must contain at least one alphanumeric character.".into());
    }

    let id = format!("webapp_{}", uuid_v4());
    let container_name = format!("bp_webapp_{slug}");
    let volume_name = format!("bp_webapp_{slug}_www");

    // Reject port already in use by another web app or instance (best-effort
    // duplicate check; Docker will also reject conflicts at run time).
    let store_check = load_store(&app);
    if store_check.web_apps.iter().any(|w| w.port == input.port)
        || store_check.instances.iter().any(|i| i.port == input.port)
    {
        return Err(format!("Port {} is already used by another instance or web app.", input.port));
    }
    if store_check
        .web_apps
        .iter()
        .any(|w| w.container_name == container_name)
    {
        return Err(format!("A web app named '{}' already exists.", input.name));
    }

    // ── Prepare on-disk config ─────────────────────────────────────────────
    let config_dir = web_app_root(&app, &id)?;
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;
    let www_dir = config_dir.join("www");
    let conf_path = config_dir.join("nginx.conf");
    let main_conf_path = config_dir.join("main.nginx.conf");

    if !is_nodejs {
        std::fs::create_dir_all(&www_dir)
            .map_err(|e| format!("Failed to create www dir: {e}"))?;

        // Resolve linked instances for nginx.conf generation
        let linked: Vec<LocalInstance> = store_check
            .instances
            .iter()
            .filter(|i| input.linked_instance_ids.contains(&i.id))
            .cloned()
            .collect();

        let nginx_conf = generate_nginx_conf(&linked);
        std::fs::write(&conf_path, &nginx_conf)
            .map_err(|e| format!("Failed to write nginx.conf: {e}"))?;

        // Main nginx config with `user root;` so workers can read bind-mounted files.
        std::fs::write(&main_conf_path, generate_main_nginx_conf())
            .map_err(|e| format!("Failed to write main.nginx.conf: {e}"))?;

        // For deploy mode: drop a placeholder index.html so the volume is
        // populated and the container has something to serve until the user
        // runs `deploy_web_app`.
        if input.mode == "deploy" {
            let placeholder = www_dir.join("index.html");
            if !placeholder.exists() {
                let html = format!(
                    "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head>\
                     <body style=\"font-family:system-ui;padding:2rem\"><h1>{}</h1>\
                     <p>This web app is running. Use <strong>Deploy</strong> to upload your built files.</p>\
                     </body></html>",
                    input.name, input.name
                );
                let _ = std::fs::write(&placeholder, html);
            }
        }
    }

    // ── Ensure no stale container with the same name exists ─────────────
    // A previous failed attempt may have left an orphaned container that is
    // not tracked in the store (build succeeded but something else crashed).
    // Force-remove it so `docker run` never hits a name conflict.
    docker_cmd(&app)
        .args(["rm", "-f", &container_name])
        .output()
        .ok(); // ignore errors (container simply may not exist)

    // ── Run the build BEFORE `docker run` ─────────────────────────────────
    // CRITICAL: on Docker Desktop (WSL2), bind-mounting a host path that
    // does not yet exist causes Docker to create an empty directory in the
    // VM that no longer syncs with later host writes. If we ran the build
    // afterwards, the user's `dist/` would never be visible to nginx and
    // every request would return 404 — regardless of how many rebuilds.
    if let (Some(cmd), Some(src)) = (&input.build_command, &input.src_path) {
        if !cmd.trim().is_empty() {
            // Auto-install dependencies if node_modules is missing.
            ensure_dependencies(src)
                .map_err(|e| format!("Dependency installation failed: {e}"))?;
            run_build_command(src, cmd)
                .map_err(|e| format!("Build failed: {e}"))?;
            if !input.build_output_dir.is_empty() {
                let out_path = PathBuf::from(src).join(&input.build_output_dir);
                if !out_path.exists() {
                    return Err(format!(
                        "Build succeeded but output dir '{}' was not found. \
                         Check your Build Output Dir setting.",
                        input.build_output_dir
                    ));
                }
            }
        }
    }

    // ── docker run ────────────────────────────────────────────────────────
    if is_nodejs {
        let src = input.src_path.as_ref().unwrap();
        let start_cmd = input
            .nodejs_start_command
            .as_deref()
            .unwrap_or("node server.js");
        validate_user_shell_command(start_cmd, "Node.js start command")?;
        let app_port = input.nodejs_app_port;
        let host_src = host_path_for_mount(&app, src)?;
        let port_bind = format!("127.0.0.1:{}:{}", input.port, app_port);

        let run_out = docker_cmd(&app)
            .args([
                "run",
                "-d",
                "--name",
                &container_name,
                "--restart",
                "unless-stopped",
                "-p",
                &port_bind,
                "-v",
                &format!("{host_src}:/app"),
                "-w",
                "/app",
                "--label",
                "app.securedbmanager.type=webapp",
                "--label",
                &format!("app.securedbmanager.project={}", input.project_id),
                "node:lts-alpine",
                "sh",
                "-c",
                start_cmd,
            ])
            .output()
            .map_err(|e| format!("Failed to run docker: {e}"))?;
        if !run_out.status.success() {
            let err = String::from_utf8_lossy(&run_out.stderr);
            return Err(format!("Failed to start Node.js web app: {err}"));
        }
    } else {
        let host_conf_mount = host_path_for_mount(&app, &conf_path.to_string_lossy())?;
        let host_main_conf_mount = host_path_for_mount(&app, &main_conf_path.to_string_lossy())?;
        let port_bind = format!("127.0.0.1:{}:80", input.port);

        let mut args: Vec<String> = vec![
            "run".into(), "-d".into(),
            "--name".into(), container_name.clone(),
            "--restart".into(), "unless-stopped".into(),
            "-p".into(), port_bind,
            // Keep container process as root; worker user is overridden in main.nginx.conf.
            "--user".into(), "root".into(),
            "-v".into(), format!("{}:/etc/nginx/nginx.conf:ro", host_main_conf_mount),
            "-v".into(), format!("{}:/etc/nginx/conf.d/default.conf:ro", host_conf_mount),
        ];

        match input.mode.as_str() {
            "dev" => {
                let src = input.src_path.as_ref().unwrap();
                // Determine what to bind-mount into nginx.
                // If a build step is configured the output lands in src/build_output_dir;
                // if no build step, serve src_path itself (e.g. a plain HTML folder).
                let has_build = input
                    .build_command
                    .as_deref()
                    .map(|c| !c.trim().is_empty())
                    .unwrap_or(false);
                let serve_dir = if has_build && !input.build_output_dir.is_empty() {
                    PathBuf::from(src).join(&input.build_output_dir).to_string_lossy().into_owned()
                } else {
                    src.clone()
                };
                // Defensive: pre-create the directory if it still doesn't exist
                // (e.g. user opted out of a build but hasn't generated files yet).
                // This guarantees the bind mount points at a real, stable inode.
                let serve_path = PathBuf::from(&serve_dir);
                if !serve_path.exists() {
                    std::fs::create_dir_all(&serve_path)
                        .map_err(|e| format!("Failed to create serve dir '{serve_dir}': {e}"))?;
                }
                let host_src = host_path_for_mount(&app, &serve_dir)?;
                args.push("-v".into());
                args.push(format!("{host_src}:/var/www/html:ro"));
            }
            "deploy" => {
                // Create the named volume; pre-seed via `docker cp` after start.
                let vol_out = docker_cmd(&app)
                    .args(["volume", "create", &volume_name])
                    .output()
                    .map_err(|e| format!("docker volume create failed: {e}"))?;
                if !vol_out.status.success() {
                    return Err(format!(
                        "docker volume create failed: {}",
                        String::from_utf8_lossy(&vol_out.stderr)
                    ));
                }
                args.push("-v".into());
                args.push(format!("{volume_name}:/var/www/html"));
            }
            _ => unreachable!(),
        }

        args.push("--label".into());
        args.push("app.securedbmanager.type=webapp".into());
        args.push("--label".into());
        args.push(format!("app.securedbmanager.project={}", input.project_id));
        args.push("nginx:alpine".into());

        let run_out = docker_cmd(&app)
            .args(&args)
            .output()
            .map_err(|e| format!("Failed to run docker: {e}"))?;
        if !run_out.status.success() {
            // Cleanup volume if we created one
            if input.mode == "deploy" {
                docker_cmd(&app)
                    .args(["volume", "rm", &volume_name])
                    .output()
                    .ok();
            }
            let err = String::from_utf8_lossy(&run_out.stderr);
            return Err(format!("Failed to start web app: {err}"));
        }
    }

    // Best-effort: join shared bridge network so proxy_pass works.
    let mode = docker_mode(&app);
    let _ = crate::commands::docker::ensure_baseport_network(&mode);
    let _ = crate::commands::docker::connect_container_to_network(&mode, &container_name);

    // ── Seed deploy-mode placeholder into the new volume ──────────────────
    if !is_nodejs && input.mode == "deploy" {
        let host_www = host_path_for_mount(&app, &www_dir.to_string_lossy())?;
        let _ = docker_cmd(&app)
            .args([
                "cp",
                &format!("{host_www}/."),
                &format!("{}:/var/www/html/", container_name),
            ])
            .output();
    }

    let now = chrono::Utc::now().to_rfc3339();
    let web_app = WebApp {
        id: id.clone(),
        name: input.name.clone(),
        container_name: container_name.clone(),
        config_path: config_dir.to_string_lossy().into_owned(),
        port: input.port,
        mode: if is_nodejs { "dev".into() } else { input.mode.clone() },
        src_path: input.src_path.clone(),
        build_output_dir: input.build_output_dir.clone(),
        build_command: input.build_command.clone(),
        container_type: input.container_type.clone(),
        nodejs_start_command: input.nodejs_start_command.clone(),
        nodejs_app_port: input.nodejs_app_port,
        status: "running".into(),
        linked_instance_ids: input.linked_instance_ids.clone(),
        project_id: input.project_id.clone(),
        created_at: now,
    };

    let mut store = load_store(&app);
    store.web_apps.push(web_app.clone());
    save_store(&app, &store)?;

    audit(&app, &web_app, "web_app.create", "success", None);
    Ok(web_app)
}

#[tauri::command]
pub fn list_web_apps(app: AppHandle, project_id: Option<String>) -> Result<Vec<WebApp>, String> {
    let mut store = load_store(&app);
    let mut changed = false;
    for w in store.web_apps.iter_mut() {
        let new_status = refresh_status(&app, &w.container_name);
        if new_status != w.status {
            w.status = new_status;
            changed = true;
        }
    }
    if changed {
        save_store(&app, &store)?;
    }
    let result = match project_id {
        Some(pid) => store
            .web_apps
            .iter()
            .filter(|w| w.project_id == pid)
            .cloned()
            .collect(),
        None => store.web_apps.clone(),
    };
    Ok(result)
}

/// Run only the build command for a web app without stopping/starting the container.
/// Returns an error if no build command is configured for this web app.
#[tauri::command]
pub async fn rebuild_web_app(app: AppHandle, id: String) -> Result<String, String> {
    let store = load_store(&app);
    let web_app = store
        .web_apps
        .iter()
        .find(|w| w.id == id)
        .ok_or("Web app not found.")?
        .clone();

    let (cmd, src) = match (&web_app.build_command, &web_app.src_path) {
        (Some(c), Some(s)) if !c.trim().is_empty() => (c.clone(), s.clone()),
        _ => return Err("This web app has no build command configured.".into()),
    };

    // Re-generate nginx confs so that any config fixes (e.g. try_files, user root)
    // take effect on existing containers without needing a full recreate.
    // Skip for Node.js containers — they don't use nginx configs.
    if web_app.container_type != "nodejs" {
        let linked: Vec<LocalInstance> = store
            .instances
            .iter()
            .filter(|i| web_app.linked_instance_ids.contains(&i.id))
            .cloned()
            .collect();
        let conf_path = PathBuf::from(&web_app.config_path).join("nginx.conf");
        let main_conf_path = PathBuf::from(&web_app.config_path).join("main.nginx.conf");
        let _ = std::fs::write(&conf_path, generate_nginx_conf(&linked));
        let _ = std::fs::write(&main_conf_path, generate_main_nginx_conf());
    }

    // Run the build (auto-install first if node_modules is missing)
    if let Err(e) = ensure_dependencies(&src) {
        audit(&app, &web_app, "web_app.rebuild", "error", Some(e.clone()));
        return Err(format!("Dependency installation failed: {e}"));
    }
    let output = match run_build_command(&src, &cmd) {
        Ok(out) => {
            audit(&app, &web_app, "web_app.rebuild", "success", None);
            out
        }
        Err(e) => {
            audit(&app, &web_app, "web_app.rebuild", "error", Some(e.clone()));
            return Err(format!("Build failed: {e}"));
        }
    };

    // Restart the container so the bind-mount is re-established against the
    // freshly written output directory. On Docker Desktop (WSL2) a simple
    // `nginx -s reload` is not enough — the kernel-level mount still points
    // at the old (possibly empty) inode. A full container restart guarantees
    // the new files are visible. Best-effort: container may be stopped.
    let _ = docker_cmd(&app)
        .args(["restart", &web_app.container_name])
        .output();

    Ok(output)
}

#[tauri::command]
pub async fn start_web_app(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = load_store(&app);
    let pos = store
        .web_apps
        .iter()
        .position(|w| w.id == id)
        .ok_or("Web app not found.")?;
    let web_app = store.web_apps[pos].clone();

    // Run the build command (if configured) before starting the container so
    // the output dir is fresh when nginx picks it up.
    if let (Some(cmd), Some(src)) = (&web_app.build_command, &web_app.src_path) {
        if !cmd.trim().is_empty() {
            match run_build_command(src, cmd) {
                Ok(_) => audit(&app, &web_app, "web_app.build", "success", None),
                Err(e) => {
                    audit(&app, &web_app, "web_app.build", "error", Some(e.clone()));
                    return Err(format!("Build failed, container not started: {e}"));
                }
            }
        }
    }

    let out = docker_cmd(&app)
        .args(["start", &web_app.container_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        audit(&app, &web_app, "web_app.start", "error", Some(err.clone()));
        return Err(format!("Failed to start web app: {err}"));
    }

    let mode = docker_mode(&app);
    let _ = crate::commands::docker::ensure_baseport_network(&mode);
    let _ = crate::commands::docker::connect_container_to_network(&mode, &web_app.container_name);

    store.web_apps[pos].status = "running".into();
    save_store(&app, &store)?;
    audit(&app, &web_app, "web_app.start", "success", None);
    Ok(())
}

#[tauri::command]
pub async fn stop_web_app(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = load_store(&app);
    let pos = store
        .web_apps
        .iter()
        .position(|w| w.id == id)
        .ok_or("Web app not found.")?;
    let web_app = store.web_apps[pos].clone();

    let out = docker_cmd(&app)
        .args(["stop", &web_app.container_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        audit(&app, &web_app, "web_app.stop", "error", Some(err.clone()));
        return Err(format!("Failed to stop web app: {err}"));
    }
    store.web_apps[pos].status = "stopped".into();
    save_store(&app, &store)?;
    audit(&app, &web_app, "web_app.stop", "success", None);
    Ok(())
}

#[tauri::command]
pub async fn delete_web_app(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = load_store(&app);
    let pos = store
        .web_apps
        .iter()
        .position(|w| w.id == id)
        .ok_or("Web app not found.")?;
    let web_app = store.web_apps[pos].clone();

    // Stop + remove container (ignore errors so deletion is robust)
    docker_cmd(&app)
        .args(["stop", &web_app.container_name])
        .output()
        .ok();
    docker_cmd(&app)
        .args(["rm", "-f", &web_app.container_name])
        .output()
        .ok();

    // Drop the deploy named volume if it was used
    if web_app.mode == "deploy" {
        let slug = web_app
            .container_name
            .strip_prefix("bp_webapp_")
            .unwrap_or(&web_app.container_name);
        let volume_name = format!("bp_webapp_{slug}_www");
        docker_cmd(&app)
            .args(["volume", "rm", &volume_name])
            .output()
            .ok();
    }

    // Remove on-disk config dir
    if let Ok(p) = web_app_root(&app, &web_app.id) {
        let _ = std::fs::remove_dir_all(p);
    }

    // Remove from store and any exposures targeting this web app
    store.web_apps.remove(pos);
    store.exposures.retain(|e| {
        !(e.target_type == "web_app" && e.instance_id == web_app.id)
    });
    save_store(&app, &store)?;
    audit(&app, &web_app, "web_app.delete", "success", None);
    Ok(())
}

#[tauri::command]
pub async fn deploy_web_app(
    app: AppHandle,
    id: String,
    src_path: String,
) -> Result<(), String> {
    let store = load_store(&app);
    let web_app = store
        .web_apps
        .iter()
        .find(|w| w.id == id)
        .ok_or("Web app not found.")?
        .clone();

    let p = PathBuf::from(&src_path);
    if !p.exists() {
        return Err(format!("Source folder does not exist: {src_path}"));
    }
    if !p.is_dir() {
        return Err(format!("Source path is not a directory: {src_path}"));
    }

    // Clear existing files first so removed assets don't linger.
    docker_cmd(&app)
        .args([
            "exec",
            &web_app.container_name,
            "sh",
            "-c",
            "rm -rf /var/www/html/* /var/www/html/.[!.]* 2>/dev/null || true",
        ])
        .output()
        .ok();

    let host_src = host_path_for_mount(&app, &src_path)?;
    let cp_out = docker_cmd(&app)
        .args([
            "cp",
            &format!("{host_src}/."),
            &format!("{}:/var/www/html/", web_app.container_name),
        ])
        .output()
        .map_err(|e| format!("docker cp failed to launch: {e}"))?;
    if !cp_out.status.success() {
        let err = String::from_utf8_lossy(&cp_out.stderr).to_string();
        audit(&app, &web_app, "web_app.deploy", "error", Some(err.clone()));
        return Err(format!("docker cp failed: {err}"));
    }
    audit(
        &app,
        &web_app,
        "web_app.deploy",
        "success",
        Some(format!("from {src_path}")),
    );
    Ok(())
}

#[tauri::command]
pub async fn get_web_app_logs(app: AppHandle, id: String, tail: Option<u32>) -> Result<String, String> {
    let store = load_store(&app);
    let web_app = store
        .web_apps
        .iter()
        .find(|w| w.id == id)
        .ok_or("Web app not found.")?
        .clone();
    let tail_str = tail.unwrap_or(200).to_string();
    let out = docker_cmd(&app)
        .args(["logs", "--tail", &tail_str, &web_app.container_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&out.stdout));
    combined.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(combined)
}

#[tauri::command]
pub async fn update_web_app_linked_instances(
    app: AppHandle,
    id: String,
    instance_ids: Vec<String>,
) -> Result<WebApp, String> {
    let mut store = load_store(&app);
    let pos = store
        .web_apps
        .iter()
        .position(|w| w.id == id)
        .ok_or("Web app not found.")?;
    let linked: Vec<LocalInstance> = store
        .instances
        .iter()
        .filter(|i| instance_ids.contains(&i.id))
        .cloned()
        .collect();
    let conf = generate_nginx_conf(&linked);
    let conf_path = PathBuf::from(&store.web_apps[pos].config_path).join("nginx.conf");
    std::fs::write(&conf_path, &conf)
        .map_err(|e| format!("Failed to write nginx.conf: {e}"))?;

    // Push updated config into the running container and reload.
    let container = store.web_apps[pos].container_name.clone();
    let host_conf = host_path_for_mount(&app, &conf_path.to_string_lossy())?;
    let cp = docker_cmd(&app)
        .args([
            "cp",
            &host_conf,
            &format!("{}:/etc/nginx/conf.d/default.conf", container),
        ])
        .output()
        .map_err(|e| format!("docker cp failed: {e}"))?;
    if !cp.status.success() {
        return Err(format!(
            "docker cp failed: {}",
            String::from_utf8_lossy(&cp.stderr)
        ));
    }
    let reload = docker_cmd(&app)
        .args(["exec", &container, "nginx", "-s", "reload"])
        .output()
        .map_err(|e| format!("nginx reload failed: {e}"))?;
    if !reload.status.success() {
        return Err(format!(
            "nginx reload failed: {}",
            String::from_utf8_lossy(&reload.stderr)
        ));
    }

    store.web_apps[pos].linked_instance_ids = instance_ids;
    let updated = store.web_apps[pos].clone();
    save_store(&app, &store)?;
    audit(&app, &updated, "web_app.update_links", "success", None);
    Ok(updated)
}

#[tauri::command]
pub fn get_web_app_connection_info(
    app: AppHandle,
    id: String,
) -> Result<WebAppConnectionInfo, String> {
    let store = load_store(&app);
    let web_app = store
        .web_apps
        .iter()
        .find(|w| w.id == id)
        .ok_or("Web app not found.")?
        .clone();

    let base_url = format!("http://localhost:{}", web_app.port);
    let mut entries = Vec::new();

    for inst_id in &web_app.linked_instance_ids {
        let Some(inst) = store.instances.iter().find(|i| &i.id == inst_id) else {
            continue;
        };
        match inst.service_type.as_str() {
            "pocketbase" => {
                let proxy_url = format!("{base_url}/pb/");
                let snippet = format!(
                    "import PocketBase from 'pocketbase';\n\
                     const pb = new PocketBase('{proxy_url}');\n\
                     // const records = await pb.collection('items').getList();"
                );
                entries.push(WebAppConnectionEntry {
                    instance_id: inst.id.clone(),
                    instance_name: inst.name.clone(),
                    service_type: inst.service_type.clone(),
                    browser_compatible: true,
                    proxy_path: Some("/pb/".into()),
                    proxy_url: Some(proxy_url),
                    sdk_snippet: Some(snippet),
                    direct_uri: None,
                    note: None,
                });
            }
            "clickhouse" => {
                let proxy_url = format!("{base_url}/ch/");
                let snippet = format!(
                    "// ClickHouse HTTP — POST SQL as the request body.\n\
                     const r = await fetch('{proxy_url}?database={}', {{\n\
                       method: 'POST',\n\
                       headers: {{ 'X-ClickHouse-User': '{}', 'X-ClickHouse-Key': '<password>' }},\n\
                       body: 'SELECT 1 FORMAT JSON'\n\
                     }});",
                    inst.db_name.as_deref().unwrap_or(""),
                    inst.username
                );
                entries.push(WebAppConnectionEntry {
                    instance_id: inst.id.clone(),
                    instance_name: inst.name.clone(),
                    service_type: inst.service_type.clone(),
                    browser_compatible: true,
                    proxy_path: Some("/ch/".into()),
                    proxy_url: Some(proxy_url),
                    sdk_snippet: Some(snippet),
                    direct_uri: None,
                    note: None,
                });
            }
            other => {
                let direct = format!("{}://{}:{}", other, inst.host, inst.port);
                entries.push(WebAppConnectionEntry {
                    instance_id: inst.id.clone(),
                    instance_name: inst.name.clone(),
                    service_type: inst.service_type.clone(),
                    browser_compatible: false,
                    proxy_path: None,
                    proxy_url: None,
                    sdk_snippet: None,
                    direct_uri: Some(direct),
                    note: Some(
                        "Browsers cannot speak this protocol directly — connect via a Node/Rust backend.".into(),
                    ),
                });
            }
        }
    }

    Ok(WebAppConnectionInfo {
        web_app_url: base_url,
        connections: entries,
    })
}

// ── Project type detection ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct WebProjectDetection {
    /// "nextjs" | "vite" | "astro" | "nuxt" | "cra" | "node" | "node-server" | "plain-html" | "unknown"
    pub project_type: String,
    /// "npm" | "pnpm" | "yarn" | "bun"
    pub package_manager: Option<String>,
    pub suggested_build_command: Option<String>,
    /// Relative output dir (e.g. "dist", "out", "build")
    pub suggested_output_dir: Option<String>,
    /// Whether nginx static hosting will work for this project
    pub compatible: bool,
    pub compatibility_note: Option<String>,
    /// Next.js API routes detected — blocks static export
    pub has_api_routes: bool,
    pub has_package_json: bool,
    /// "nginx" (static) | "nodejs" (run a Node.js server in a node:lts-alpine container)
    pub suggested_container_type: String,
    /// Command to start the app inside a Node.js container.
    pub suggested_start_command: Option<String>,
    /// Port the Node.js app listens on inside the container.
    pub suggested_app_port: Option<u16>,
}

#[tauri::command]
pub fn detect_web_project(path: String) -> Result<WebProjectDetection, String> {
    use std::path::Path;

    let root = Path::new(&path);
    if !root.exists() || !root.is_dir() {
        return Err(format!("Path does not exist or is not a directory: {path}"));
    }

    let has_package_json = root.join("package.json").exists();

    let package_manager: Option<String> = if root.join("pnpm-lock.yaml").exists() {
        Some("pnpm".to_string())
    } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        Some("bun".to_string())
    } else if root.join("yarn.lock").exists() {
        Some("yarn".to_string())
    } else if root.join("package-lock.json").exists() || has_package_json {
        Some("npm".to_string())
    } else {
        None
    };

    let pkg_content = if has_package_json {
        std::fs::read_to_string(root.join("package.json")).ok()
    } else {
        None
    };
    let pkg = pkg_content.as_deref().unwrap_or("");

    let has_next_config = ["next.config.ts", "next.config.js", "next.config.mjs"]
        .iter()
        .any(|f| root.join(f).exists());
    let has_vite_config = ["vite.config.ts", "vite.config.js", "vite.config.mjs"]
        .iter()
        .any(|f| root.join(f).exists());
    let has_astro_config = ["astro.config.ts", "astro.config.js", "astro.config.mjs"]
        .iter()
        .any(|f| root.join(f).exists());
    let has_nuxt_config = ["nuxt.config.ts", "nuxt.config.js"]
        .iter()
        .any(|f| root.join(f).exists());

    let has_next_dep  = pkg.contains("\"next\"");
    let has_vite_dep  = pkg.contains("\"vite\"");
    let has_astro_dep = pkg.contains("\"astro\"");
    let has_nuxt_dep  = pkg.contains("\"nuxt\"");
    let has_cra       = pkg.contains("\"react-scripts\"");
    let has_build_script = pkg.contains("\"build\"");
    let has_index_html = root.join("index.html").exists();

    let pm = package_manager.clone().unwrap_or_else(|| "npm".to_string());

    // ── Next.js ────────────────────────────────────────────────────────────
    if has_next_config || has_next_dep {
        let has_api_routes = root.join("app").join("api").exists()
            || root.join("pages").join("api").exists();

        let config_src = ["next.config.ts", "next.config.js", "next.config.mjs"]
            .iter()
            .find_map(|f| std::fs::read_to_string(root.join(f)).ok())
            .unwrap_or_default();
        let has_static_export = config_src.contains("output") && config_src.contains("export");
        let has_standalone = config_src.contains("output") && config_src.contains("standalone");

        // Static export path: nginx-compatible (only when no API routes).
        if has_static_export && !has_api_routes {
            return Ok(WebProjectDetection {
                project_type: "nextjs".to_string(),
                package_manager,
                suggested_build_command: Some(format!("{pm} run build")),
                suggested_output_dir: Some("out".to_string()),
                compatible: true,
                compatibility_note: Some(
                    "Next.js static export — `next build` writes to out/. Ready for nginx hosting.".to_string(),
                ),
                has_api_routes: false,
                has_package_json,
                suggested_container_type: "nginx".to_string(),
                suggested_start_command: None,
                suggested_app_port: None,
            });
        }

        // Standalone output path: optimized Node.js server.
        if has_standalone {
            return Ok(WebProjectDetection {
                project_type: "nextjs".to_string(),
                package_manager,
                suggested_build_command: Some(format!("{pm} run build")),
                suggested_output_dir: None,
                compatible: true,
                compatibility_note: Some(
                    "Next.js standalone output detected — will run via node:lts-alpine container.".to_string(),
                ),
                has_api_routes,
                has_package_json,
                suggested_container_type: "nodejs".to_string(),
                suggested_start_command: Some("node .next/standalone/server.js".to_string()),
                suggested_app_port: Some(3000),
            });
        }

        // Default Next.js (API routes or no static export): run as Node.js server.
        let note = if has_api_routes {
            "Next.js with API routes detected — will run via node:lts-alpine container."
        } else {
            "Next.js detected — running as Node.js server (use `output: 'export'` in next.config for static nginx hosting)."
        };
        return Ok(WebProjectDetection {
            project_type: "nextjs".to_string(),
            package_manager,
            suggested_build_command: Some(format!("{pm} run build")),
            suggested_output_dir: None,
            compatible: true,
            compatibility_note: Some(note.to_string()),
            has_api_routes,
            has_package_json,
            suggested_container_type: "nodejs".to_string(),
            suggested_start_command: Some("./node_modules/.bin/next start -p 3000".to_string()),
            suggested_app_port: Some(3000),
        });
    }

    // ── Astro ──────────────────────────────────────────────────────────────
    if has_astro_config || has_astro_dep {
        return Ok(WebProjectDetection {
            project_type: "astro".to_string(),
            package_manager,
            suggested_build_command: Some(format!("{pm} run build")),
            suggested_output_dir: Some("dist".to_string()),
            compatible: true,
            compatibility_note: Some(
                "Astro generates static HTML by default. Works great with nginx.".to_string(),
            ),
            has_api_routes: false,
            has_package_json,
            suggested_container_type: "nginx".to_string(),
            suggested_start_command: None,
            suggested_app_port: None,
        });
    }

    // ── Nuxt ───────────────────────────────────────────────────────────────
    if has_nuxt_config || has_nuxt_dep {
        let nuxt_src = ["nuxt.config.ts", "nuxt.config.js"]
            .iter()
            .find_map(|f| std::fs::read_to_string(root.join(f)).ok())
            .unwrap_or_default();
        // SSR off / generate config → static via nginx.
        let static_nuxt = nuxt_src.contains("ssr: false")
            || nuxt_src.contains("ssr:false")
            || pkg.contains("\"generate\"");

        if static_nuxt {
            return Ok(WebProjectDetection {
                project_type: "nuxt".to_string(),
                package_manager,
                suggested_build_command: Some(format!("{pm} run generate")),
                suggested_output_dir: Some(".output/public".to_string()),
                compatible: true,
                compatibility_note: Some(
                    "Nuxt static generation — `nuxi generate` writes to .output/public. Compatible with nginx.".to_string(),
                ),
                has_api_routes: false,
                has_package_json,
                suggested_container_type: "nginx".to_string(),
                suggested_start_command: None,
                suggested_app_port: None,
            });
        }

        return Ok(WebProjectDetection {
            project_type: "nuxt".to_string(),
            package_manager,
            suggested_build_command: Some(format!("{pm} run build")),
            suggested_output_dir: None,
            compatible: true,
            compatibility_note: Some(
                "Nuxt SSR detected — will run via node:lts-alpine container.".to_string(),
            ),
            has_api_routes: false,
            has_package_json,
            suggested_container_type: "nodejs".to_string(),
            suggested_start_command: Some("node .output/server/index.mjs".to_string()),
            suggested_app_port: Some(3000),
        });
    }

    // ── Vite ──────────────────────────────────────────────────────────────
    if has_vite_config || has_vite_dep {
        return Ok(WebProjectDetection {
            project_type: "vite".to_string(),
            package_manager,
            suggested_build_command: Some(format!("{pm} run build")),
            suggested_output_dir: Some("dist".to_string()),
            compatible: true,
            compatibility_note: Some(
                "Vite produces a static build in dist/. Works perfectly with nginx.".to_string(),
            ),
            has_api_routes: false,
            has_package_json,
            suggested_container_type: "nginx".to_string(),
            suggested_start_command: None,
            suggested_app_port: None,
        });
    }

    // ── Create React App ───────────────────────────────────────────────────
    if has_cra {
        return Ok(WebProjectDetection {
            project_type: "cra".to_string(),
            package_manager,
            suggested_build_command: Some(format!("{pm} run build")),
            suggested_output_dir: Some("build".to_string()),
            compatible: true,
            compatibility_note: Some(
                "Create React App outputs to build/. Works with nginx.".to_string(),
            ),
            has_api_routes: false,
            has_package_json,
            suggested_container_type: "nginx".to_string(),
            suggested_start_command: None,
            suggested_app_port: None,
        });
    }

    // ── Node.js server (Express/Fastify/Koa/Hapi or generic entrypoint) ────
    let has_express = pkg.contains("\"express\"");
    let has_fastify = pkg.contains("\"fastify\"");
    let has_koa = pkg.contains("\"koa\"");
    let has_hapi = pkg.contains("\"@hapi/hapi\"");
    let entry_file = ["server.js", "index.js", "app.js", "src/index.js", "src/server.js"]
        .iter()
        .find(|f| root.join(f).exists())
        .copied();

    if has_express
        || has_fastify
        || has_koa
        || has_hapi
        || (has_package_json && entry_file.is_some() && !has_build_script && !has_index_html)
    {
        let start_cmd = if let Some(f) = entry_file {
            format!("node {f}")
        } else {
            format!("{pm} start")
        };
        return Ok(WebProjectDetection {
            project_type: "node-server".to_string(),
            package_manager,
            suggested_build_command: None,
            suggested_output_dir: None,
            compatible: true,
            compatibility_note: Some(
                "Node.js server detected — will run in a node:lts-alpine container.".to_string(),
            ),
            has_api_routes: false,
            has_package_json,
            suggested_container_type: "nodejs".to_string(),
            suggested_start_command: Some(start_cmd),
            suggested_app_port: Some(3000),
        });
    }

    // ── Generic Node project with a build script ───────────────────────────
    if has_package_json && has_build_script {
        return Ok(WebProjectDetection {
            project_type: "node".to_string(),
            package_manager,
            suggested_build_command: Some(format!("{pm} run build")),
            suggested_output_dir: Some("dist".to_string()),
            compatible: true,
            compatibility_note: Some(
                "Found a build script — output directory may differ. \
                 Verify dist/ is correct for your toolchain."
                    .to_string(),
            ),
            has_api_routes: false,
            has_package_json,
            suggested_container_type: "nginx".to_string(),
            suggested_start_command: None,
            suggested_app_port: None,
        });
    }

    // ── Plain HTML ─────────────────────────────────────────────────────────
    if has_index_html {
        return Ok(WebProjectDetection {
            project_type: "plain-html".to_string(),
            package_manager: None,
            suggested_build_command: None,
            suggested_output_dir: None,
            compatible: true,
            compatibility_note: Some(
                "Plain HTML/CSS/JS — no build step needed. Nginx serves the folder directly."
                    .to_string(),
            ),
            has_api_routes: false,
            has_package_json,
            suggested_container_type: "nginx".to_string(),
            suggested_start_command: None,
            suggested_app_port: None,
        });
    }

    // ── Unknown ────────────────────────────────────────────────────────────
    Ok(WebProjectDetection {
        project_type: "unknown".to_string(),
        package_manager,
        suggested_build_command: None,
        suggested_output_dir: None,
        compatible: true,
        compatibility_note: Some(
            "Could not detect project type. Choose a build command manually.".to_string(),
        ),
        has_api_routes: false,
        has_package_json,
        suggested_container_type: "nginx".to_string(),
        suggested_start_command: None,
        suggested_app_port: None,
    })
}
