# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Baseport
(`secure-db-manager`), please **do not open a public issue**.

Instead, report it privately by either:

- Opening a [GitHub Security Advisory](../../security/advisories/new), or
- Emailing the maintainer (see the repository owner's GitHub profile for
  contact information).

Please include:

- A clear description of the issue and the impact.
- Steps to reproduce, or a proof-of-concept if possible.
- The affected version / commit hash.
- Any suggested mitigations.

You can expect an initial response within a few business days. Coordinated
disclosure is appreciated — once a fix is available we will credit reporters
who request it.

## Scope

In scope:

- The Tauri desktop application (Rust backend in `src-tauri/`, React frontend
  in `src/`).
- IPC commands and the surface they expose to the embedded webview.
- Local credential handling (OS keyring usage, on-disk metadata files).
- Shell-command construction (`docker`, `netsh`, `ufw`, `iptables`,
  `cloudflared`, `ngrok`, `lt`).

Out of scope:

- Vulnerabilities in upstream dependencies (please report those upstream;
  we will pick up patched versions).
- Issues that require an attacker to already have local code execution as
  the same user — this app is a single-user desktop tool and explicitly
  trusts the local user.
- Misuse of intentionally user-supplied shell commands (e.g. the web-app
  build/start command). These run on the user's own machine with their own
  permissions by design.

## Threat Model (Summary)

- **Trust boundary:** the local OS user.
- **Stored locally (encrypted via OS keyring):** database passwords, ngrok
  tokens, remote-host passwords.
- **Stored locally (plaintext JSON):** instance / host / web-app metadata
  such as names, ports, hostnames, usernames. Treat the app data directory
  as sensitive.
- **Network egress:** Docker registry, package managers (npm/pnpm/yarn/bun)
  during web-app builds, optional tunnelling services (Cloudflare, ngrok,
  localtunnel), and hard-coded providers used to detect the public IPv4
  address (`api.ipify.org`, `checkip.amazonaws.com`, `icanhazip.com`).
- **Network ingress:** only what the user explicitly creates via the
  Exposures feature.

## Hardening Already in Place

- IPC capabilities are restricted via `src-tauri/capabilities/default.json`.
- All container ports default to binding `127.0.0.1`.
- Service versions and types are validated against fixed allowlists before
  any image tag is constructed.
- Database/user identifiers are restricted to `[A-Za-z0-9_]`.
- Firewall rule names are restricted to `[A-Za-z0-9 _-]`.
- A strict Content-Security-Policy is set on the Tauri webview.
- Passwords are masked by default in the connection-strings UI.
- Backup export refuses to copy files outside the app data directory.
- Public-IP detection accepts only well-formed IPv4/IPv6 responses.

## Known Residual Risks

- The web-app feature deliberately runs user-supplied build/start commands
  through a shell; this is a feature, not a bug.
- Downloaded helper binaries (`cloudflared`, `ngrok`, `lt`) are fetched over
  HTTPS but are not yet verified by checksum / signature. Pin or verify
  binaries yourself if you need stronger supply-chain guarantees.
- The local store JSON is not encrypted at rest; rely on filesystem
  permissions and full-disk encryption for protection.
