# Deploying Baseport in Server (VPS / Web) Mode

Baseport ships in two flavours:

| Mode      | Binary             | Auth     | Storage                          |
|-----------|--------------------|----------|----------------------------------|
| Desktop   | `baseport` (Tauri) | none     | OS keyring                       |
| Server    | `baseport-server`  | JWT      | AES-256-GCM `secrets.bin` file   |

Both share the same Rust core and the same React frontend. The server build
adds an Axum HTTP API + JWT auth, and the frontend's transport layer
auto-detects which mode it's running in (`isTauri()` probes
`window.__TAURI_INTERNALS__`).

---

## Quick start with Docker Compose

```bash
git clone https://github.com/<you>/secure-db-manager
cd secure-db-manager
cp .env.example .env
# Edit .env — generate every secret with `openssl rand -base64 32`.
docker compose up -d
```

Baseport now listens on `127.0.0.1:8473`. Front it with the supplied
`deploy/nginx.conf` (TLS via Let's Encrypt) or any other reverse proxy.

---

## Required environment variables

| Variable                    | Required | Notes                                                |
|-----------------------------|----------|------------------------------------------------------|
| `BASEPORT_SECRET_KEY`       | yes      | ≥32 chars. AES-256-GCM master key for secrets file. |
| `BASEPORT_ADMIN_PASSWORD`   | yes      | ≥8 chars. Bcrypt-hashed at startup, never stored.   |
| `BASEPORT_JWT_SECRET`       | yes      | ≥32 chars. HS256 signing key.                       |
| `BASEPORT_ALLOWED_ORIGIN`   | optional | CORS allow-list. Omit only in dev.                  |
| `BASEPORT_DATA_DIR`         | optional | Default `./baseport-data`. Holds `local_store.json` + `secrets.bin`. |
| `BASEPORT_PORT`             | optional | Default `8473`.                                     |
| `BASEPORT_TOKEN_EXPIRY_HOURS` | optional | Default `24`.                                     |
| `RUST_LOG`                  | optional | Default `info,tower_http=info`.                     |

Rotate any of these at any time — `BASEPORT_JWT_SECRET` rotation invalidates
all currently-issued tokens (every browser must log in again).

---

## Architecture cheat-sheet

```
         ┌────────────────────────────┐
 browser │  React SPA (same bundle    │
   ───►  │  used by desktop)          │
         └─────────────┬──────────────┘
                       │ HTTPS
                       ▼
         ┌────────────────────────────┐
 nginx   │  Reverse proxy + TLS       │
         └─────────────┬──────────────┘
                       │ HTTP :8473
                       ▼
         ┌────────────────────────────┐
 axum    │  baseport-server           │
         │  (Rust, JWT auth, SSE)     │
         └─────┬────────────┬─────────┘
               │            │
               ▼            ▼
        local_store.json  Docker socket
        secrets.bin       (host)
```

---

## Single-binary deployment (no Docker)

If you'd rather run the bare binary, build it yourself:

```bash
cd src-tauri
cargo build --release --bin baseport-server --features server
sudo install -m 0755 target/release/baseport-server /usr/local/bin/
sudo cp ../deploy/baseport-server.service /etc/systemd/system/
sudo useradd --system --create-home --home /var/lib/baseport baseport
sudoedit /etc/baseport.env       # paste the contents of .env here
sudo systemctl daemon-reload
sudo systemctl enable --now baseport-server
```

The systemd unit is hardened (`NoNewPrivileges`, `ProtectSystem=strict`,
restricted address families) — see [`deploy/baseport-server.service`](deploy/baseport-server.service).

---

## V1 capability matrix

The server build exposes the full read surface today; the mutating
operations are progressively being ported. Anything not yet on the HTTP
API throws `"this endpoint is not yet supported in web mode (desktop only)"`
on the frontend so you can plan around it.

Already on the HTTP API:
- Login / logout / whoami
- List instances, hosts, exposures, web apps, backups, audit logs
- Get data dir
- Real-time events via SSE (`GET /api/events`)

Coming next: create / start / stop / delete for instances, hosts, exposures,
and web apps. The Rust-side primitives (`local_store::*_at`, `crate::secrets::*`,
Docker invocations) already work in both modes — the remaining work is
wiring each command's body to a route handler.

---

## Security checklist

- [ ] Strong, unique `BASEPORT_SECRET_KEY`, `BASEPORT_JWT_SECRET`, `BASEPORT_ADMIN_PASSWORD` (use `openssl rand -base64 32`).
- [ ] Restrict `0.0.0.0:8473` exposure — bind via `127.0.0.1:` in compose so only the proxy can reach it.
- [ ] TLS at the reverse proxy. The HTTP server itself speaks plain HTTP.
- [ ] `BASEPORT_ALLOWED_ORIGIN` set to your real public URL.
- [ ] `secrets.bin` and `local_store.json` live on an encrypted volume — they contain credentials for every database.
- [ ] Mounting `/var/run/docker.sock` is equivalent to root on the host. Use a dedicated VPS.
