import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Server,
  Globe,
  ShieldCheck,
  Network,
  Archive,
  ClipboardList,
  Settings,
} from "lucide-react";

const navItems = [
  { label: "Overview", to: "/", icon: LayoutDashboard },
  { label: "Local Instances", to: "/local", icon: Server },
  { label: "Remote Hosts", to: "/hosts", icon: Globe },
  { label: "Access Broker", to: "/broker", icon: ShieldCheck },
  { label: "Exposures", to: "/exposures", icon: Network },
  { label: "Backups", to: "/backups", icon: Archive },
  { label: "Audit Logs", to: "/audit", icon: ClipboardList },
  { label: "Settings", to: "/settings", icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
          <ShieldCheck className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="text-sm font-semibold tracking-tight text-foreground">
          Secure DB Manager
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

      {/* Version */}
      <div className="border-t border-border px-4 py-3">
        <span className="text-xs text-muted-foreground">v0.1.0 — MVP</span>
      </div>
    </aside>
  );
}
