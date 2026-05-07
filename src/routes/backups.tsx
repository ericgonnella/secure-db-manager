import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listBackups,
  listLocalInstances,
  restoreInstance,
  deleteBackup,
  type BackupRecord,
  type LocalInstance,
} from "@/lib/tauri";
import {
  Archive,
  RotateCcw,
  Trash2,
  HardDrive,
  Check,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// ── Backup row ─────────────────────────────────────────────────────────────

function BackupRow({
  backup,
  instanceName,
}: {
  backup: BackupRecord;
  instanceName: string;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);

  const restoreMut = useMutation({
    mutationFn: () =>
      restoreInstance({ instance_id: backup.instance_id, source_file: backup.file_path }),
    onSuccess: () => {
      setRestoreResult({ ok: true, msg: "Restore completed. Container restarted." });
      queryClient.invalidateQueries({ queryKey: ["local-instances"] });
    },
    onError: (e) => {
      setRestoreResult({ ok: false, msg: String(e) });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteBackup(backup.id),
    onSuccess: () => {
      setConfirmDelete(false);
      queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
  });

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
          <Archive className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {instanceName}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {backup.file_path}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-xs text-muted-foreground">{formatDate(backup.created_at)}</p>
          <p className="text-xs font-mono text-foreground">{formatBytes(backup.size_bytes)}</p>
        </div>

        {backup.note && (
          <p className="shrink-0 max-w-[160px] truncate text-xs text-muted-foreground italic">
            {backup.note}
          </p>
        )}

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            disabled={restoreMut.isPending}
            onClick={() => {
              setRestoreResult(null);
              restoreMut.mutate();
            }}
            title="Restore from this backup"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <RotateCcw
              className={cn("h-3.5 w-3.5", restoreMut.isPending && "animate-spin")}
            />
          </button>
          <button
            disabled={deleteMut.isPending}
            onClick={() => setConfirmDelete(true)}
            title="Delete backup"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {restoreResult && (
        <div
          className={cn(
            "border-t px-5 py-2.5 flex items-start gap-2 text-xs",
            restoreResult.ok
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
              : "border-destructive/30 bg-destructive/5 text-destructive"
          )}
        >
          {restoreResult.ok ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>{restoreResult.msg}</span>
        </div>
      )}

      {confirmDelete && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-5 py-3 flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">
            Delete this backup file? This cannot be undone.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setConfirmDelete(false)}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
            >
              Cancel
            </button>
            <button
              disabled={deleteMut.isPending}
              onClick={() => deleteMut.mutate()}
              className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {deleteMut.isPending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Instance group ─────────────────────────────────────────────────────────

function InstanceGroup({
  instanceName,
  backups,
}: {
  instanceName: string;
  backups: BackupRecord[];
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="space-y-2">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-left"
      >
        <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium text-foreground">{instanceName}</span>
        <span className="text-xs text-muted-foreground">{backups.length} backup{backups.length !== 1 ? "s" : ""}</span>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <div className="space-y-2 pl-6">
          {backups.map((b) => (
            <BackupRow key={b.id} backup={b} instanceName={instanceName} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function BackupsPage() {
  const [filterInstanceId, setFilterInstanceId] = useState<string>("all");

  const { data: backups = [], isLoading: loadingBackups } = useQuery({
    queryKey: ["backups"],
    queryFn: () => listBackups(),
  });

  const { data: instances = [] } = useQuery({
    queryKey: ["local-instances"],
    queryFn: listLocalInstances,
  });

  const instanceMap = new Map<string, LocalInstance>(
    instances.map((i) => [i.id, i])
  );

  const filtered =
    filterInstanceId === "all"
      ? backups
      : backups.filter((b) => b.instance_id === filterInstanceId);

  // Group by instance_id
  const groups = new Map<string, BackupRecord[]>();
  for (const b of filtered) {
    const arr = groups.get(b.instance_id) ?? [];
    arr.push(b);
    groups.set(b.instance_id, arr);
  }

  const totalSize = filtered.reduce((acc, b) => acc + b.size_bytes, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Backups
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            All backup snapshots across managed instances.
          </p>
        </div>

        {filtered.length > 0 && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{filtered.length} backup{filtered.length !== 1 ? "s" : ""}</span>
            <span>·</span>
            <span>{formatBytes(totalSize)} total</span>
          </div>
        )}
      </div>

      {/* Filter */}
      {instances.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setFilterInstanceId("all")}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              filterInstanceId === "all"
                ? "bg-primary text-primary-foreground"
                : "border border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
            )}
          >
            All instances
          </button>
          {instances.map((inst) => (
            <button
              key={inst.id}
              onClick={() => setFilterInstanceId(inst.id)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                filterInstanceId === inst.id
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
              )}
            >
              {inst.name}
            </button>
          ))}
        </div>
      )}

      {loadingBackups ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
          <Archive className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm font-medium text-foreground">No backups yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create a backup from an instance's action panel.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(groups.entries()).map(([instanceId, groupBackups]) => (
            <InstanceGroup
              key={instanceId}
              instanceName={instanceMap.get(instanceId)?.name ?? instanceId}
              backups={groupBackups}
            />
          ))}
        </div>
      )}
    </div>
  );
}
