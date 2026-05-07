import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  backupInstance,
  restoreInstance,
  listBackups,
  deleteBackup,
  type LocalInstance,
  type BackupRecord,
} from "@/lib/tauri";
import { X, Archive, Upload, Trash2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

interface BackupManagerProps {
  instance: LocalInstance;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function BackupManager({ instance, onClose }: BackupManagerProps) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const { data: backups = [], isLoading } = useQuery({
    queryKey: ["backups", instance.id],
    queryFn: () => listBackups(instance.id),
  });

  const backupMut = useMutation({
    mutationFn: async () => {
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose backup destination folder",
      });
      if (!dir || typeof dir !== "string") {
        throw new Error("No folder selected.");
      }
      return backupInstance({
        instance_id: instance.id,
        destination_dir: dir,
        note: note.trim() ? note.trim() : null,
      });
    },
    onSuccess: () => {
      setNote("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["backups", instance.id] });
    },
    onError: (err) => setError(String(err)),
  });

  const restoreMut = useMutation({
    mutationFn: async (record: BackupRecord) => {
      return restoreInstance({
        instance_id: instance.id,
        source_file: record.file_path,
      });
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["local-instances"] });
    },
    onError: (err) => setError(String(err)),
  });

  const restoreFromFileMut = useMutation({
    mutationFn: async () => {
      const file = await openDialog({
        multiple: false,
        title: "Choose backup file (.tar.gz)",
        filters: [{ name: "Backup", extensions: ["tar.gz", "tgz", "gz"] }],
      });
      if (!file || typeof file !== "string") {
        throw new Error("No file selected.");
      }
      return restoreInstance({
        instance_id: instance.id,
        source_file: file,
      });
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["local-instances"] });
    },
    onError: (err) => setError(String(err)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteBackup(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      queryClient.invalidateQueries({ queryKey: ["backups", instance.id] });
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">
              Backups — {instance.name}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Snapshots of <span className="font-mono">{instance.volume_name}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Create */}
        <div className="space-y-3 border-b border-border px-6 py-4">
          <p className="text-xs font-medium text-foreground">Create new backup</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Optional note (e.g. before-migration)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <button
              onClick={() => backupMut.mutate()}
              disabled={backupMut.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              {backupMut.isPending ? "Backing up…" : "Backup"}
            </button>
            <button
              onClick={() => restoreFromFileMut.mutate()}
              disabled={restoreFromFileMut.isPending}
              title="Restore from file…"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              Restore file…
            </button>
          </div>
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        {/* History */}
        <div className="flex-1 overflow-auto px-6 py-4">
          <p className="mb-2 text-xs font-medium text-foreground">History</p>
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : backups.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No backups yet for this instance.
            </p>
          ) : (
            <ul className="space-y-2">
              {backups.map((b) => (
                <li
                  key={b.id}
                  className="rounded-lg border border-border bg-muted/30 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs text-foreground">
                        {b.file_path}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {new Date(b.created_at).toLocaleString()} ·{" "}
                        {formatSize(b.size_bytes)}
                        {b.note ? ` · ${b.note}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => restoreMut.mutate(b)}
                        disabled={restoreMut.isPending}
                        title="Restore this backup"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(b.id)}
                        title="Delete backup"
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive",
                          confirmDeleteId === b.id && "text-destructive"
                        )}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {confirmDeleteId === b.id && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5">
                      <p className="text-[11px] text-destructive">
                        Delete this backup file from disk?
                      </p>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded border border-border bg-background px-2 py-0.5 text-[10px]"
                        >
                          Cancel
                        </button>
                        <button
                          disabled={deleteMut.isPending}
                          onClick={() => deleteMut.mutate(b.id)}
                          className="rounded bg-destructive px-2 py-0.5 text-[10px] font-medium text-destructive-foreground disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
