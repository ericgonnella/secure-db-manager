/**
 * Mode-agnostic transport layer for the desktop / web split.
 *
 * Desktop (Tauri shell present)  →  forwards every call to `@tauri-apps/api/core`
 *                                   `invoke(cmd, args)` exactly as before.
 *
 * Browser (no Tauri shell)        →  translates `(cmd, args)` into an HTTP
 *                                   request against the headless `baseport-server`
 *                                   binary. Auth is a JWT held only in module
 *                                   scope (NEVER persisted to localStorage —
 *                                   that's the standard XSS-mitigation pattern).
 *
 * Mapping coverage in V1: the read-only command surface that the server
 * exposes today (login, list_*, audit logs, data dir). Mutating commands
 * fall through to a clear error so the UI can show "desktop-only for now".
 *
 * Public API mirrors `@tauri-apps/api/core`:
 *   - `invoke<T>(cmd, args?)`         → returns the resolved JSON or throws
 *   - `listen(event, handler)`        → SSE on the web, Tauri events on desktop
 *   - `isTauri()`                     → cached env probe
 *   - `setAuthToken(token | null)`    → call after login on web mode
 *   - `getAuthToken()`                → read for UI flows that need it
 */

// ── Environment probe ──────────────────────────────────────────────────────

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

let _isTauri: boolean | null = null;

export function isTauri(): boolean {
  if (_isTauri !== null) return _isTauri;
  _isTauri =
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined";
  return _isTauri;
}

// ── Auth token (web mode only) ─────────────────────────────────────────────

let _token: string | null = null;
const _tokenListeners = new Set<(t: string | null) => void>();

export function setAuthToken(token: string | null): void {
  _token = token;
  _tokenListeners.forEach((fn) => fn(token));
}

export function getAuthToken(): string | null {
  return _token;
}

export function onAuthTokenChange(fn: (t: string | null) => void): () => void {
  _tokenListeners.add(fn);
  return () => _tokenListeners.delete(fn);
}

// ── Tauri-side adapter ─────────────────────────────────────────────────────

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let _tauriInvoke: InvokeFn | null = null;

async function getTauriInvoke(): Promise<InvokeFn> {
  if (_tauriInvoke) return _tauriInvoke;
  const mod = await import("@tauri-apps/api/core");
  _tauriInvoke = mod.invoke as InvokeFn;
  return _tauriInvoke;
}

// ── HTTP-side adapter ──────────────────────────────────────────────────────

/**
 * Maps a Tauri command name onto an HTTP route. Each entry returns the
 * `(method, path, body?)` tuple. Args use snake_case to match the Rust
 * command argument names exactly.
 */
type HttpRoute =
  | { method: "GET" | "DELETE"; path: string; body?: undefined }
  | { method: "POST" | "PUT"; path: string; body?: unknown };

function commandToHttp(
  cmd: string,
  args?: Record<string, unknown>,
): HttpRoute | null {
  switch (cmd) {
    // Auth
    case "auth_login":
      return { method: "POST", path: "/api/auth/login", body: args };
    case "auth_logout":
      return { method: "POST", path: "/api/auth/logout", body: {} };
    case "auth_whoami":
      return { method: "GET", path: "/api/auth/whoami" };

    // Read-only listings (mirror the server router in Phase 2)
    case "list_local_instances":
      return { method: "GET", path: "/api/instances" };
    case "list_remote_hosts":
      return { method: "GET", path: "/api/hosts" };
    case "list_audit_logs":
      return { method: "GET", path: "/api/audit-logs" };
    case "list_exposures":
      return { method: "GET", path: "/api/exposures" };
    case "list_web_apps":
      return { method: "GET", path: "/api/web-apps" };
    case "list_backups":
      return { method: "GET", path: "/api/backups" };
    case "get_data_dir":
      return { method: "GET", path: "/api/config/data-dir" };

    default:
      return null;
  }
}

/**
 * Base URL for HTTP calls in web mode. Defaults to the same origin the
 * page was served from, which is the expected production layout
 * (reverse proxy fronts both the static SPA and `/api/*`).
 */
function apiBaseUrl(): string {
  // Allow override at build time via Vite env for dev workflows.
  const fromEnv =
    typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: { VITE_BASEPORT_API_URL?: string } })
      .env?.VITE_BASEPORT_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

async function httpInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const route = commandToHttp(cmd, args);
  if (!route) {
    throw new Error(
      `Command "${cmd}" is not yet supported in web mode (desktop only).`,
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (_token) headers.Authorization = `Bearer ${_token}`;

  const init: RequestInit = {
    method: route.method,
    headers,
    credentials: "include",
  };
  if (route.method === "POST" || route.method === "PUT") {
    init.body = JSON.stringify(route.body ?? {});
  }

  const res = await fetch(`${apiBaseUrl()}${route.path}`, init);
  if (res.status === 401) {
    setAuthToken(null);
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* non-JSON body — keep generic message */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Unified API ────────────────────────────────────────────────────────────

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri()) {
    const tauri = await getTauriInvoke();
    return tauri<T>(cmd, args);
  }
  return httpInvoke<T>(cmd, args);
}

// ── Events ─────────────────────────────────────────────────────────────────

export type Unlisten = () => void;

interface SsePayload<T> {
  payload: T;
}

let _sse: EventSource | null = null;
const _channelListeners = new Map<string, Set<(payload: unknown) => void>>();

function ensureSse(): void {
  if (_sse || !_token) return;
  // EventSource has no header support — we pass the token via query string.
  // The server allows the JWT on the query for the SSE endpoint specifically.
  // (Implemented as a follow-up: today the server requires Authorization,
  // so until that's relaxed the SSE channel is best-effort and may stay closed.)
  const url = `${apiBaseUrl()}/api/events?token=${encodeURIComponent(_token)}`;
  try {
    _sse = new EventSource(url, { withCredentials: true });
  } catch {
    _sse = null;
    return;
  }
  _sse.onerror = () => {
    _sse?.close();
    _sse = null;
  };
}

/**
 * Subscribe to a backend event channel. Compatible signature with
 * `@tauri-apps/api/event`'s `listen`.
 */
export async function listen<T>(
  channel: string,
  handler: (event: SsePayload<T>) => void,
): Promise<Unlisten> {
  if (isTauri()) {
    const mod = await import("@tauri-apps/api/event");
    const unlisten = await mod.listen<T>(channel, handler);
    return unlisten;
  }

  // Web mode: SSE.
  ensureSse();
  const wrapped = (payload: unknown) => handler({ payload: payload as T });
  let set = _channelListeners.get(channel);
  if (!set) {
    set = new Set();
    _channelListeners.set(channel, set);
    if (_sse) {
      _sse.addEventListener(channel, (ev: MessageEvent) => {
        let parsed: unknown = ev.data;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          /* leave as string */
        }
        _channelListeners
          .get(channel)
          ?.forEach((fn) => fn(parsed));
      });
    }
  }
  set.add(wrapped);
  return () => {
    set?.delete(wrapped);
  };
}
