import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth-context";

/**
 * Login screen for web (browser) mode.
 *
 * Renders only when running outside Tauri AND the user has no valid token.
 * The desktop binary never reaches this route — `AuthGuard` short-circuits.
 */
export function LoginPage() {
  const { login, loading, error } = useAuth();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await login(username, password);
    } catch {
      /* error is surfaced via useAuth().error */
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-lg shadow-md p-6 space-y-4 border border-zinc-200 dark:border-zinc-800"
      >
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Baseport</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Sign in to continue
          </p>
        </div>

        <div className="space-y-2">
          <label className="block">
            <span className="text-sm font-medium">Username</span>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </label>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition-colors"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
