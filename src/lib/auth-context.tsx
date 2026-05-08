/**
 * Authentication context.
 *
 * In Tauri (desktop) mode there's no auth — every render returns
 * `{ authenticated: true }` and the login form is bypassed.
 *
 * In web mode the JWT lives in module-level memory inside `transport.ts`
 * (NEVER localStorage — that's the standard XSS-mitigation pattern).
 * Reload = forced re-login. This is intentional for V1.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  invoke,
  isTauri,
  setAuthToken,
  getAuthToken,
  onAuthTokenChange,
} from "./transport";

interface LoginResponse {
  token: string;
  expires_in: number;
}

interface AuthState {
  authenticated: boolean;
  username: string | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Tauri desktop is always "authenticated" — single-user local app.
  const tauri = isTauri();
  const [token, setToken] = useState<string | null>(getAuthToken());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tauri) return;
    return onAuthTokenChange((t) => setToken(t));
  }, [tauri]);

  const login = useCallback(async (username: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<LoginResponse>("auth_login", {
        username,
        password,
      });
      setAuthToken(res.token);
      setToken(res.token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await invoke("auth_logout");
    } catch {
      /* server logout is best-effort — token is dropped client-side */
    }
    setAuthToken(null);
    setToken(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      authenticated: tauri || token !== null,
      username: tauri ? "desktop" : token ? "admin" : null,
      loading,
      error,
      login,
      logout,
    }),
    [tauri, token, loading, error, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
