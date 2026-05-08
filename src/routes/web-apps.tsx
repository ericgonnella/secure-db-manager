import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  Plus,
  Play,
  Square,
  Trash2,
  ScrollText,
  Plug,
  Upload,
  ExternalLink,
  Hammer,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjects } from "@/lib/projects";
import { StatusBadge } from "@/components/status-badge";
import {
  listWebApps,
  startWebApp,
  stopWebApp,
  deleteWebApp,
  deployWebApp,
  rebuildWebApp,
  type WebApp,
} from "@/lib/tauri";
import { CreateWebAppWizard } from "@/features/web-apps/create-web-app-wizard";
import { WebAppConnectionInfo } from "@/features/web-apps/web-app-connection-info";
import { WebAppLogsViewer } from "@/features/web-apps/web-app-logs-viewer";
import { ExposeWizard } from "@/features/exposures/expose-wizard";

function modeBadge(mode: string) {
  return mode === "dev"
    ? "text-blue-500 bg-blue-500/10"
    : "text-purple-500 bg-purple-500/10";
}

function WebAppRow({ app }: { app: WebApp }) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showExpose, setShowExpose] = useState(false);

  const startMut = useMutation({
    mutationFn: () => startWebApp(app.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web-apps"] }),
  });
  const stopMut = useMutation({
    mutationFn: () => stopWebApp(app.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web-apps"] }),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteWebApp(app.id),
    onSuccess: () => {
      setConfirmDelete(false);
      qc.invalidateQueries({ queryKey: ["web-apps"] });
    },
  });
  const deployMut = useMutation({
    mutationFn: (path: string) => deployWebApp(app.id, path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web-apps"] }),
  });
  const rebuildMut = useMutation({
    mutationFn: () => rebuildWebApp(app.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web-apps"] }),
  });

  async function pickAndDeploy() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") deployMut.mutate(sel);
  }

  const url = `http://localhost:${app.port}`;
  const busy =
    startMut.isPending ||
    stopMut.isPending ||
    deleteMut.isPending ||
    deployMut.isPending ||
    rebuildMut.isPending;

  return (
    <>
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
          <AppWindow className="h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-foreground">
              {app.name}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                modeBadge(app.mode),
              )}
            >
              {app.mode}
            </span>
            {app.linked_instance_ids.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                {app.linked_instance_ids.length} linked
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <button
              onClick={() => openUrl(url)}
              className="hover:text-foreground"
            >
              {url}
            </button>
            {" · "}
            <span className="font-mono">{app.container_name}</span>
          </p>
        </div>

        <StatusBadge
          variant={
            app.status === "running"
              ? "success"
              : app.status === "stopped"
                ? "error"
                : "warning"
          }
        >
          {app.status}
        </StatusBadge>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => openUrl(url)}
            title="Open"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowInfo(true)}
            title="Connection info"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plug className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowExpose(true)}
            disabled={app.status !== "running"}
            title={
              app.status === "running"
                ? "Expose publicly"
                : "Start the web app to enable public exposure"
            }
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Radio className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowLogs(true)}
            title="Logs"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ScrollText className="h-3.5 w-3.5" />
          </button>
          {app.mode === "dev" && app.build_command && (
            <button
              disabled={busy}
              onClick={() => rebuildMut.mutate()}
              title={rebuildMut.isPending ? "Building…" : "Rebuild"}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Hammer
                className={cn(
                  "h-3.5 w-3.5",
                  rebuildMut.isPending && "animate-pulse text-blue-500",
                  rebuildMut.isError && "text-red-500",
                )}
              />
            </button>
          )}
          {app.mode === "deploy" && (
            <button
              disabled={busy}
              onClick={pickAndDeploy}
              title="Deploy build"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Upload className="h-3.5 w-3.5" />
            </button>
          )}
          {app.status === "running" ? (
            <button
              disabled={busy}
              onClick={() => stopMut.mutate()}
              title="Stop"
              className="flex h-7 w-7 items-center justify-center rounded-md text-amber-500 hover:bg-amber-500/10 disabled:opacity-40"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => startMut.mutate()}
              title="Start"
              className="flex h-7 w-7 items-center justify-center rounded-md text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            title="Delete"
            className="flex h-7 w-7 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 className="text-sm font-semibold">Delete web app?</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              This removes the container, files, and any related exposures.
              This cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
                className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {deleteMut.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLogs && (
        <WebAppLogsViewer webApp={app} onClose={() => setShowLogs(false)} />
      )}
      {showInfo && (
        <WebAppConnectionInfo webApp={app} onClose={() => setShowInfo(false)} />
      )}
      {showExpose && (
        <ExposeWizard webApp={app} onClose={() => setShowExpose(false)} />
      )}
    </>
  );
}

export function WebAppsPage() {
  const { currentProjectId } = useProjects();
  const [showCreate, setShowCreate] = useState(false);

  const { data: apps = [], isLoading } = useQuery<WebApp[]>({
    queryKey: ["web-apps"],
    queryFn: listWebApps,
  });

  const filtered = apps.filter((a) => a.project_id === currentProjectId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Web Apps</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Host static front-end apps in nginx, with proxy access to your
            local databases.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
        >
          <Plus className="h-3.5 w-3.5" />
          New Web App
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <AppWindow className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <h3 className="mt-3 text-sm font-medium">No web apps yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Create a web app to host a static front-end (Vite, CRA, Next export,
            plain HTML) directly from this app, with built-in proxies to your
            local databases.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
          >
            <Plus className="h-3.5 w-3.5" />
            New Web App
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((app) => (
            <WebAppRow key={app.id} app={app} />
          ))}
        </div>
      )}

      {showCreate && <CreateWebAppWizard onClose={() => setShowCreate(false)} />}
    </div>
  );
}
