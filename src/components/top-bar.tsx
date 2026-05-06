import { Search } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "@/lib/utils";

export function TopBar({ className }: { className?: string }) {
  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4",
        className
      )}
    >
      {/* Project selector placeholder */}
      <button className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        Default Project
        <span className="ml-1 text-muted-foreground/60">▾</span>
      </button>

      {/* Search placeholder */}
      <div className="relative flex-1 max-w-xs">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          placeholder="Search…"
          className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          readOnly
        />
      </div>

      <div className="flex-1" />

      {/* Theme toggle */}
      <ThemeToggle />
    </header>
  );
}
