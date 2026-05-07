import { useState, useRef, useEffect } from "react";
import { Search, Plus, Check, FolderOpen } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "@/lib/utils";
import { useProjects } from "@/lib/projects";

export function TopBar({ className }: { className?: string }) {
  const { projects, currentProjectId, setCurrentProjectId, createProject } =
    useProjects();
  const currentProject = projects.find((p) => p.id === currentProjectId);

  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
        setNewName("");
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  function handleCreateProject() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const project = createProject(trimmed);
    setCurrentProjectId(project.id);
    setAdding(false);
    setNewName("");
    setOpen(false);
  }

  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4",
        className
      )}
    >
      {/* Project selector */}
      <div ref={dropdownRef} className="relative">
        <button
          onClick={() => {
            setOpen((v) => !v);
            setAdding(false);
          }}
          className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors hover:bg-muted"
        >
          <FolderOpen className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          <span className="max-w-[140px] truncate">
            {currentProject?.name ?? "Default Project"}
          </span>
          <span className="ml-1 text-muted-foreground/60 text-xs">▾</span>
        </button>

        {open && (
          <div className="absolute left-0 top-full z-50 mt-1.5 w-56 rounded-xl border border-border bg-card shadow-lg">
            <div className="max-h-48 overflow-y-auto py-1">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setCurrentProjectId(p.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-muted transition-colors"
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      p.id === currentProjectId
                        ? "text-primary"
                        : "text-transparent"
                    )}
                  />
                  <span className="flex-1 truncate text-foreground">{p.name}</span>
                </button>
              ))}
            </div>

            <div className="border-t border-border px-2 py-2">
              {adding ? (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateProject();
                      if (e.key === "Escape") {
                        setAdding(false);
                        setNewName("");
                      }
                    }}
                    placeholder="Project name…"
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <button
                    onClick={handleCreateProject}
                    disabled={!newName.trim()}
                    className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setAdding(true)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  New project
                </button>
              )}
            </div>
          </div>
        )}
      </div>

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
