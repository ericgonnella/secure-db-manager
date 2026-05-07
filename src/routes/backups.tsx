import { useState, useMemo, useCallback, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  listBackups,
  listLocalInstances,
  backupInstance,
  restoreInstance,
  deleteBackup,
  exportBackup,
  openBackupFolder,
  type BackupRecord,
  type LocalInstance,
} from "@/lib/tauri";
import {
  useBackupSchedules,
  useScheduleRunner,
  INTERVAL_OPTIONS,
  type ScheduleInterval,
} from "@/lib/backup-schedules";
import { useProjects } from "@/lib/projects";
import {
  Archive,
  RotateCcw,
  Trash2,
  HardDrive,
  ChevronDown,
  ChevronUp,
  Settings2,
  Clock,
  Download,
  FolderOpen,
  Copy,
  Check,
  AlertCircle,
  Plus,
  Play,
  Lock,
  FolderSearch,
  CalendarClock,
  ShieldOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "â€”";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60_000) return past ? "just now" : "< 1 min";
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min${past ? " ago" : ""}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h${past ? " ago" : ""}`;
  return `${Math.round(abs / 86_400_000)}d${past ? " ago" : ""}`;
}

// â”€â”€ Service-type config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SERVICE_META: Record<string, { label: string; color: string; dot: string }> = {
  postgres:   { label: "PostgreSQL",  color: "text-sky-500 bg-sky-500/10",         dot: "bg-sky-500"       },
  mysql:      { label: "MySQL",       color: "text-orange-500 bg-orange-500/10",   dot: "bg-orange-500"    },
  mariadb:    { label: "MariaDB",     color: "text-teal-500 bg-teal-500/10",       dot: "bg-teal-500"      },
  redis:      { label: "Redis",       color: "text-red-500 bg-red-500/10",         dot: "bg-red-500"       },
  mongodb:    { label: "MongoDB",     color: "text-emerald-500 bg-emerald-500/10", dot: "bg-emerald-500"   },
  clickhouse: { label: "ClickHouse",  color: "text-yellow-500 bg-yellow-500/10",   dot: "bg-yellow-500"    },
  pocketbase: { label: "PocketBase",  color: "text-violet-500 bg-violet-500/10",   dot: "bg-violet-500"    },
};

function ServiceBadge({ type }: { type: string }) {
  const meta = SERVICE_META[type] ?? {
    label: type,
    color: "text-muted-foreground bg-muted",
    dot: "bg-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        meta.color
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

// â”€â”€ Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface ToastMsg { id: number; text: string; ok: boolean }

function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = useCallback((text: string, ok = true) => {
    const id = Date.now();
    setToasts((p) => [...p, { id, text, ok }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3500);
  }, []);
  return { toasts, push };
}

function Toasts({ toasts }: { toasts: ToastMsg[] }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs font-medium shadow-lg",
            t.ok
              ? "border-emerald-500/30 bg-card text-emerald-500"
              : "border-destructive/30 bg-card text-destructive"
          )}
        >
          {t.ok ? <Check className="h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

// â”€â”€ ActionBtn â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ActionBtn({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40",
        danger
          ? "hover:bg-red-500/10 hover:text-red-500"
          : "hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

// â”€â”€ Backup row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function BackupRow({
  backup,
  onToast,
}: {
  backup: BackupRecord;
  onToast: (msg: string, ok?: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  const restoreMut = useMutation({
    mutationFn: () =>
      restoreInstance({ instance_id: backup.instance_id, source_file: backup.file_path }),
    onSuccess: () => {
      onToast("Restore completed. Container restarted.");
      queryClient.invalidateQueries({ queryKey: ["local-instances"] });
    },
    onError: (e) => onToast(String(e), false),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteBackup(backup.id),
    onSuccess: () => {
      setConfirmDelete(false);
      queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (e) => onToast(String(e), false),
  });

  const exportMut = useMutation({
    mutationFn: async () => {
      const dir = await openDialog({ directory: true, multiple: false, title: "Export backup toâ€¦" });
      if (!dir || typeof dir !== "string") throw new Error("No folder selected.");
      return exportBackup(backup.id, dir);
    },
    onSuccess: (path) => onToast(`Exported â†’ ${path}`),
    onError: (e) => onToast(String(e), false),
  });

  const openFolderMut = useMutation({
    mutationFn: () => openBackupFolder(backup.id),
    onError: (e) => onToast(String(e), false),
  });

  function copyPath() {
    navigator.clipboard.writeText(backup.file_path).catch(() => {});
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 1500);
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-500">
          <Archive className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground font-mono truncate">
            {backup.file_path.split(/[\\/]/).pop()}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {formatDate(backup.created_at)} Â· {formatBytes(backup.size_bytes)}
            {backup.note ? <span className="italic"> Â· {backup.note}</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <ActionBtn onClick={copyPath} title="Copy file path">
            {copiedPath ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          </ActionBtn>
          <ActionBtn onClick={() => openFolderMut.mutate()} disabled={openFolderMut.isPending} title="Open folder">
            <FolderOpen className="h-3.5 w-3.5" />
          </ActionBtn>
          <ActionBtn onClick={() => exportMut.mutate()} disabled={exportMut.isPending} title="Export a copyâ€¦">
            <Download className="h-3.5 w-3.5" />
          </ActionBtn>
          <ActionBtn onClick={() => restoreMut.mutate()} disabled={restoreMut.isPending} title="Restore">
            <RotateCcw className={cn("h-3.5 w-3.5", restoreMut.isPending && "animate-spin")} />
          </ActionBtn>
          <ActionBtn onClick={() => setConfirmDelete(true)} disabled={deleteMut.isPending} title="Delete" danger>
            <Trash2 className="h-3.5 w-3.5" />
          </ActionBtn>
        </div>
      </div>
      {confirmDelete && (
        <div className="flex items-center justify-between gap-4 border-t border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-xs text-destructive">Delete this backup file from disk?</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setConfirmDelete(false)}
              className="rounded border border-border bg-background px-2.5 py-1 text-[11px] font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              disabled={deleteMut.isPending}
              onClick={() => deleteMut.mutate()}
              className="rounded bg-destructive px-2.5 py-1 text-[11px] font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >
              {deleteMut.isPending ? "Deletingâ€¦" : "Delete"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// â”€â”€ Schedule drawer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ScheduleDrawer({
  instance,
  onClose,
  onToast,
}: {
  instance: LocalInstance;
  onClose: () => void;
  onToast: (msg: string, ok?: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { getSettings, updateSchedule, updateRetention } = useBackupSchedules();
  const cfg = getSettings(instance.id);
  const { schedule, retention } = cfg;
  const [dirError, setDirError] = useState<string | null>(null);

  const { data: backups = [] } = useQuery({
    queryKey: ["backups", instance.id],
    queryFn: () => listBackups(instance.id),
  });

  async function applyRetentionNow() {
    if (!retention.keepLastN && !retention.maxAgeDays) {
      onToast("No retention rules configured.", false);
      return;
    }
    const sorted = [...backups].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const pruned: BackupRecord[] = [];
    if (retention.keepLastN !== null && retention.keepLastN > 0) {
      pruned.push(...sorted.slice(retention.keepLastN));
    }
    if (retention.maxAgeDays !== null && retention.maxAgeDays > 0) {
      const cutoff = Date.now() - retention.maxAgeDays * 86_400_000;
      for (const b of sorted) {
        if (new Date(b.created_at).getTime() < cutoff && !pruned.find((p) => p.id === b.id)) {
          pruned.push(b);
        }
      }
    }
    if (pruned.length === 0) { onToast("No backups qualify for pruning."); return; }
    for (const b of pruned) {
      try { await deleteBackup(b.id); } catch { /* continue */ }
    }
    await queryClient.invalidateQueries({ queryKey: ["backups"] });
    onToast(`Pruned ${pruned.length} backup${pruned.length !== 1 ? "s" : ""}.`);
  }

  async function browseDest() {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose backup destination folder" });
    if (dir && typeof dir === "string") {
      setDirError(null);
      updateSchedule(instance.id, { destinationDir: dir });
    }
  }

  function toggleEnabled(checked: boolean) {
    if (checked && !schedule.destinationDir) {
      setDirError("Choose a destination folder before enabling the schedule.");
      return;
    }
    setDirError(null);
    updateSchedule(instance.id, { enabled: checked });
  }

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground">
          Schedule &amp; Retention
        </p>
        <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
          Close
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Schedule column */}
        <div className="space-y-3 rounded-lg border border-border bg-card p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
            Auto-backup schedule
          </p>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">
              Destination folder
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
                {schedule.destinationDir || "Not set"}
              </code>
              <button
                type="button"
                onClick={() => void browseDest()}
                className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-[11px] font-medium hover:bg-muted"
              >
                <FolderSearch className="h-3 w-3" />
                Browse
              </button>
            </div>
            {dirError && <p className="mt-1 text-[10px] text-red-500">{dirError}</p>}
          </div>
          <div>
            <label
              htmlFor={`interval-${instance.id}`}
              className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              Interval
            </label>
            <select
              id={`interval-${instance.id}`}
              value={schedule.intervalHours}
              onChange={(e) =>
                updateSchedule(instance.id, { intervalHours: Number(e.target.value) as ScheduleInterval })
              }
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {INTERVAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-foreground">Enable schedule</p>
              {schedule.enabled && schedule.nextRun && (
                <p className="text-[10px] text-muted-foreground">Next: {formatRelative(schedule.nextRun)}</p>
              )}
              {schedule.lastRun && (
                <p className="text-[10px] text-muted-foreground">Last: {formatRelative(schedule.lastRun)}</p>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={schedule.enabled}
              onClick={() => toggleEnabled(!schedule.enabled)}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                schedule.enabled ? "bg-primary" : "bg-muted"
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-white shadow transition",
                  schedule.enabled ? "translate-x-4" : "translate-x-0.5"
                )}
              />
            </button>
          </div>
        </div>

        {/* Retention + Encryption column */}
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-card p-3 space-y-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <ShieldOff className="h-3.5 w-3.5 text-muted-foreground" />
              Retention rules
            </p>
            <div>
              <label
                htmlFor={`keep-n-${instance.id}`}
                className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                Keep last N backups (0 = unlimited)
              </label>
              <input
                id={`keep-n-${instance.id}`}
                type="number"
                min={0}
                value={retention.keepLastN ?? 0}
                onChange={(e) =>
                  updateRetention(instance.id, { keepLastN: Number(e.target.value) || null })
                }
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label
                htmlFor={`max-age-${instance.id}`}
                className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                Delete older than N days (0 = unlimited)
              </label>
              <input
                id={`max-age-${instance.id}`}
                type="number"
                min={0}
                value={retention.maxAgeDays ?? 0}
                onChange={(e) =>
                  updateRetention(instance.id, { maxAgeDays: Number(e.target.value) || null })
                }
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <button
              type="button"
              onClick={() => void applyRetentionNow()}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:bg-muted"
            >
              Apply retention now
            </button>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  Encrypt backup files
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">AES-256 â€” coming in v0.2</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={false}
                disabled
                className="relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full bg-muted opacity-50"
              >
                <span className="inline-block h-4 w-4 translate-x-0.5 transform rounded-full bg-white shadow" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// â”€â”€ Instance group â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function InstanceGroup({
  instance,
  backups,
  onToast,
}: {
  instance: LocalInstance;
  backups: BackupRecord[];
  onToast: (msg: string, ok?: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const { getSettings } = useBackupSchedules();
  const cfg = getSettings(instance.id);
  const totalSize = backups.reduce((a, b) => a + b.size_bytes, 0);

  const backupNowMut = useMutation({
    mutationFn: async () => {
      const dir = await openDialog({ directory: true, multiple: false, title: `Backup "${instance.name}" toâ€¦` });
      if (!dir || typeof dir !== "string") throw new Error("No folder selected.");
      return backupInstance({ instance_id: instance.id, destination_dir: dir, note: null });
    },
    onSuccess: () => {
      onToast(`Backup created for ${instance.name}.`);
      queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (e) => onToast(String(e), false),
  });

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex flex-1 min-w-0 items-center gap-3 text-left"
          aria-expanded={!collapsed}
        >
          <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">
            {instance.name}
          </span>
          <ServiceBadge type={instance.service_type} />
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {backups.length} backup{backups.length !== 1 ? "s" : ""} Â· {formatBytes(totalSize)}
          </span>
          {collapsed ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>

        <div className="flex items-center gap-1 shrink-0">
          {cfg.schedule.enabled && (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              <Clock className="h-2.5 w-2.5" />
              Scheduled
            </span>
          )}
          <button
            type="button"
            title="Schedule & retention settings"
            onClick={() => setShowSchedule((v) => !v)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              showSchedule && "bg-muted text-foreground"
            )}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={instance.status !== "running" ? "Instance must be running to backup" : "Backup now"}
            disabled={backupNowMut.isPending || instance.status !== "running"}
            onClick={() => backupNowMut.mutate()}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            {backupNowMut.isPending ? (
              <Archive className="h-3.5 w-3.5 animate-pulse" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {showSchedule && (
        <ScheduleDrawer instance={instance} onClose={() => setShowSchedule(false)} onToast={onToast} />
      )}

      {!collapsed && (
        <div className="border-t border-border px-4 py-3">
          {backups.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              No backups yet â€” click{" "}
              <Plus className="inline h-3 w-3 mx-0.5" />
              to create one.
            </p>
          ) : (
            <div className="space-y-2">
              {[...backups]
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .map((b) => (
                  <BackupRow key={b.id} backup={b} onToast={onToast} />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// â”€â”€ Project section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ProjectSection({
  projectName,
  instances,
  backupsMap,
  onToast,
}: {
  projectName: string;
  instances: LocalInstance[];
  backupsMap: Map<string, BackupRecord[]>;
  onToast: (msg: string, ok?: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [backingUpAll, setBackingUpAll] = useState(false);

  const totalBackups = instances.reduce((n, inst) => n + (backupsMap.get(inst.id)?.length ?? 0), 0);
  const totalSize = instances.reduce(
    (n, inst) => n + (backupsMap.get(inst.id) ?? []).reduce((s, b) => s + b.size_bytes, 0),
    0
  );

  async function backupAllRunning() {
    const running = instances.filter((i) => i.status === "running");
    if (running.length === 0) { onToast("No running instances in this project.", false); return; }
    const dir = await openDialog({ directory: true, multiple: false, title: `Backup all instances in "${projectName}"` });
    if (!dir || typeof dir !== "string") return;
    setBackingUpAll(true);
    let ok = 0;
    const failed: string[] = [];
    for (const inst of running) {
      try { await backupInstance({ instance_id: inst.id, destination_dir: dir, note: "bulk" }); ok++; }
      catch { failed.push(inst.name); }
    }
    await queryClient.invalidateQueries({ queryKey: ["backups"] });
    setBackingUpAll(false);
    if (failed.length) {
      onToast(`${ok} backed up, ${failed.length} failed: ${failed.join(", ")}`, false);
    } else {
      onToast(`${ok} backup${ok !== 1 ? "s" : ""} created.`);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 pl-1">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex flex-1 min-w-0 items-center gap-2 text-left"
          aria-expanded={!collapsed}
        >
          <span className="truncate text-sm font-semibold text-foreground">{projectName}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {totalBackups} backup{totalBackups !== 1 ? "s" : ""} Â· {formatBytes(totalSize)}
          </span>
          {collapsed ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        <button
          type="button"
          disabled={backingUpAll}
          onClick={() => void backupAllRunning()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {backingUpAll ? <Archive className="h-3 w-3 animate-pulse" /> : <Play className="h-3 w-3" />}
          Backup all
        </button>
      </div>

      {!collapsed && (
        <div className="space-y-2 border-l-2 border-border pl-2">
          {instances.map((inst) => (
            <InstanceGroup
              key={inst.id}
              instance={inst}
              backups={backupsMap.get(inst.id) ?? []}
              onToast={onToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// â”€â”€ Primitives â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "border border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Stat({ icon, label, highlight }: { icon: ReactNode; label: string; highlight?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", highlight ? "text-primary" : "text-muted-foreground")}>
      {icon}
      {label}
    </span>
  );
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      <div className="mb-3 text-muted-foreground/40">{icon}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

// â”€â”€ Page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function BackupsPage() {
  const [filterType, setFilterType] = useState<string>("all");
  const [bulkExporting, setBulkExporting] = useState(false);
  const { projects } = useProjects();
  const { toasts, push: pushToast } = useToasts();
  const { store: scheduleStore, markRan } = useBackupSchedules();

  const { data: backups = [], isLoading: loadingBackups } = useQuery({
    queryKey: ["backups"],
    queryFn: () => listBackups(),
    refetchInterval: 30_000,
  });

  const { data: instances = [] } = useQuery({
    queryKey: ["local-instances"],
    queryFn: listLocalInstances,
  });

  // Fire overdue scheduled backups in the background.
  useScheduleRunner(instances, scheduleStore, markRan, (name) =>
    pushToast(`Scheduled backup completed: ${name}`)
  );

  const serviceTypes = useMemo(() => {
    const types = new Set(instances.map((i) => i.service_type));
    return Array.from(types).sort();
  }, [instances]);

  const filteredInstances = useMemo(
    () => filterType === "all" ? instances : instances.filter((i) => i.service_type === filterType),
    [instances, filterType]
  );

  const filteredInstanceIds = useMemo(
    () => new Set(filteredInstances.map((i) => i.id)),
    [filteredInstances]
  );

  const backupsMap = useMemo(() => {
    const map = new Map<string, BackupRecord[]>();
    for (const b of backups) {
      if (!filteredInstanceIds.has(b.instance_id)) continue;
      const arr = map.get(b.instance_id) ?? [];
      arr.push(b);
      map.set(b.instance_id, arr);
    }
    return map;
  }, [backups, filteredInstanceIds]);

  const projectInstancesMap = useMemo(() => {
    const map = new Map<string, LocalInstance[]>();
    for (const inst of filteredInstances) {
      const arr = map.get(inst.project_id) ?? [];
      arr.push(inst);
      map.set(inst.project_id, arr);
    }
    return map;
  }, [filteredInstances]);

  const filteredBackups = backups.filter((b) => filteredInstanceIds.has(b.instance_id));
  const totalSize = filteredBackups.reduce((n, b) => n + b.size_bytes, 0);
  const scheduledCount = filteredInstances.filter((i) => scheduleStore[i.id]?.schedule.enabled).length;
  const nextRuns = filteredInstances
    .map((i) => scheduleStore[i.id]?.schedule.nextRun)
    .filter(Boolean)
    .map((d) => new Date(d!).getTime());
  const nextScheduled = nextRuns.length ? new Date(Math.min(...nextRuns)).toISOString() : null;

  async function bulkExport() {
    if (filteredBackups.length === 0) return;
    const dir = await openDialog({ directory: true, multiple: false, title: "Export all backups toâ€¦" });
    if (!dir || typeof dir !== "string") return;
    setBulkExporting(true);
    let ok = 0;
    const failures: string[] = [];
    for (const b of filteredBackups) {
      try { await exportBackup(b.id, dir); ok++; }
      catch (e) { failures.push(String(e)); }
    }
    setBulkExporting(false);
    if (failures.length) {
      pushToast(`${ok} exported, ${failures.length} failed.`, false);
    } else {
      pushToast(`${ok} backup${ok !== 1 ? "s" : ""} exported to ${dir}`);
    }
  }

  const orphanInstances = filteredInstances.filter(
    (i) => !projects.find((p) => p.id === i.project_id)
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Backups</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Manage snapshots, schedules, and retention for all instances.
          </p>
        </div>
        {filteredBackups.length > 0 && (
          <button
            type="button"
            disabled={bulkExporting}
            onClick={() => void bulkExport()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <Download className={cn("h-3.5 w-3.5", bulkExporting && "animate-bounce")} />
            {bulkExporting ? "Exportingâ€¦" : "Export all"}
          </button>
        )}
      </div>

      {/* Summary bar */}
      {filteredBackups.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
          <Stat icon={<Archive className="h-3.5 w-3.5" />} label={`${filteredBackups.length} backup${filteredBackups.length !== 1 ? "s" : ""}`} />
          <Stat icon={<HardDrive className="h-3.5 w-3.5" />} label={formatBytes(totalSize)} />
          {scheduledCount > 0 && (
            <Stat icon={<Clock className="h-3.5 w-3.5 text-primary" />} label={`${scheduledCount} scheduled`} highlight />
          )}
          {nextScheduled && (
            <Stat icon={<CalendarClock className="h-3.5 w-3.5" />} label={`Next: ${formatRelative(nextScheduled)}`} />
          )}
        </div>
      )}

      {/* Service-type filter chips */}
      {serviceTypes.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip active={filterType === "all"} onClick={() => setFilterType("all")}>
            All types
          </FilterChip>
          {serviceTypes.map((t) => {
            const meta = SERVICE_META[t];
            return (
              <FilterChip key={t} active={filterType === t} onClick={() => setFilterType(t)}>
                <span className={cn("h-1.5 w-1.5 rounded-full", meta?.dot ?? "bg-muted-foreground")} aria-hidden />
                {meta?.label ?? t}
              </FilterChip>
            );
          })}
        </div>
      )}

      {/* Body */}
      {loadingBackups ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">Loadingâ€¦</div>
      ) : instances.length === 0 ? (
        <EmptyState
          icon={<HardDrive className="h-10 w-10" />}
          title="No instances yet"
          body="Create an instance first, then come back to manage its backups."
        />
      ) : filteredInstances.length === 0 ? (
        <EmptyState
          icon={<Archive className="h-10 w-10" />}
          title="No instances match this filter"
          body="Try selecting a different service type."
        />
      ) : (
        <div className="space-y-8">
          {Array.from(projectInstancesMap.entries())
            .filter(([projectId]) => projects.find((p) => p.id === projectId))
            .map(([projectId, instList]) => {
              const project = projects.find((p) => p.id === projectId)!;
              return (
                <ProjectSection
                  key={projectId}
                  projectName={project.name}
                  instances={instList}
                  backupsMap={backupsMap}
                  onToast={pushToast}
                />
              );
            })}
          {orphanInstances.length > 0 && (
            <ProjectSection
              key="__orphan"
              projectName="Unassigned"
              instances={orphanInstances}
              backupsMap={backupsMap}
              onToast={pushToast}
            />
          )}
        </div>
      )}

      <Toasts toasts={toasts} />
    </div>
  );
}
