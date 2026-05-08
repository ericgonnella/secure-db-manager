import type { ReactNode } from "react";
import { useAuth } from "../lib/auth-context";
import { LoginPage } from "../routes/login";

/**
 * Renders `children` when the user is authenticated, otherwise the login
 * screen. In Tauri (desktop) mode this is always a passthrough — there's
 * no auth there.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const { authenticated } = useAuth();
  if (!authenticated) return <LoginPage />;
  return <>{children}</>;
}
