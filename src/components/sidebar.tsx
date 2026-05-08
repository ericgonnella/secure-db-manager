import { NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Server,
  Globe,
  Network,
  Archive,
  ClipboardList,
  Settings,
  Container,
  Terminal,
  AppWindow,
} from "lucide-react";
import { detectDocker, type DockerStatus } from "@/lib/tauri";
import logo from "@/assets/logo.png";

const navItems = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard },
  { label: "Local Instances", to: "/local", icon: Server },
  { label: "Web Apps", to: "/web-apps", icon: AppWindow },
  { label: "Remote Hosts", to: "/hosts", icon: Globe },
  { label: "Exposures", to: "/exposures", icon: Network },
  { label: "Backups", to: "/backups", icon: Archive },
  { label: "Audit Logs", to: "/audit", icon: ClipboardList },
  { label: "Settings", to: "/settings", icon: Settings },
];

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        ok ? "bg-emerald-500" : "bg-red-500"
      )}
      aria-label={ok ? "OK" : "Error"}
    />
  );
}

function DockerFooterIndicators() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery<DockerStatus>({
    queryKey: ["docker-status"],
    queryFn: detectDocker,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const cliOk = !!data?.cli_available;
  const daemonOk = !!data?.daemon_running;

  if (isLoading) {
    return (
      <div className="border-t border-border px-2 py-2">
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          Docker
        </div>
        <div className="px-2 py-1 text-xs text-muted-foreground">Checking…</div>
      </div>
    );
  }

  return (
    <div className="border-t border-border px-2 py-2">
      <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Docker
      </div>
      <button
        onClick={() => navigate("/docker")}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={
          data?.cli_version
            ? `Docker CLI ${data.cli_version}`
            : "Docker CLI not detected"
        }
      >
        <Terminal className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">Docker CLI</span>
        <StatusDot ok={cliOk} />
      </button>
      <button
        onClick={() => navigate("/docker")}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={
          daemonOk
            ? "Docker daemon is reachable"
            : data?.daemon_error ?? "Docker daemon not reachable"
        }
      >
        <Container className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">Docker Daemon</span>
        <StatusDot ok={daemonOk} />
      </button>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
        <img
          src={logo}
          alt="Baseport"
          className="h-7 w-7 rounded-md object-cover"
        />
        <span className="text-sm font-semibold tracking-tight text-foreground">
          Baseport
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {navItems.map(({ label, to, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-primary/8 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Docker status footer */}
      <DockerFooterIndicators />

      {/* Version */}
      <div className="border-t border-border px-4 py-3">
        <span className="text-xs text-muted-foreground">v0.1.0 — MVP</span>
      </div>
    </aside>
  );
}
