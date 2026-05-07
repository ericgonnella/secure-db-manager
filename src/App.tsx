import {
  BrowserRouter,
  Routes,
  Route,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./components/app-shell";
import { ProjectProvider } from "./lib/projects";
import { DashboardPage } from "./routes/dashboard";
import { LocalInstancesPage } from "./routes/local-instances";
import { AuditLogsPage } from "./routes/audit-logs";
import { BackupsPage } from "./routes/backups";
import { PlaceholderPage } from "./routes/placeholder";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Apply persisted theme before first render
function initTheme() {
  const stored = localStorage.getItem("sdm-theme") ?? "system";
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark =
    stored === "dark" || (stored === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
}
initTheme();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route
              path="/local"
              element={<LocalInstancesPage />}
            />
            <Route
              path="/hosts"
              element={<PlaceholderPage title="Remote Hosts" />}
            />
            <Route
              path="/broker"
              element={<PlaceholderPage title="Access Broker" />}
            />
            <Route
              path="/backups"
              element={<BackupsPage />}
            />
            <Route
              path="/audit"
              element={<AuditLogsPage />}
            />
            <Route
              path="/settings"
              element={<PlaceholderPage title="Settings" />}
            />
          </Route>
        </Routes>
      </BrowserRouter>
      </ProjectProvider>
    </QueryClientProvider>
  );
}

