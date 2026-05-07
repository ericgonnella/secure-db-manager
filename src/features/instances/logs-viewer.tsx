import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getContainerLogs, type LocalInstance } from "@/lib/tauri";
import { X, RefreshCw, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

const TAIL_OPTIONS = [100, 200, 500, 1000, 2000] as const;

interface LogsViewerProps {
  instance: LocalInstance;
  onClose: () => void;
}

export function LogsViewer({ instance, onClose }: LogsViewerProps) {
  const [tail, setTail] = useState<number>(200);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLPreElement>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["container-logs", instance.id, tail],
    queryFn: () => getContainerLogs(instance.id, tail),
    refetchInterval: autoRefresh ? 2000 : false,
    refetchOnWindowFocus: false,
  });

  // Stick to the bottom whenever logs change
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [data]);

  function copyLogs() {
    if (!data) return;
    navigator.clipboard.writeText(data).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex h-[80vh] w-full max-w-4xl flex-col rounded-2xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">
              Logs — {instance.name}
            </h2>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {instance.container_name}
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

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Tail</span>
            <div className="inline-flex gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
              {TAIL_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setTail(n)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    tail === n
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Auto-refresh (2s)
            </label>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              title="Refresh"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isFetching && "animate-spin")}
              />
            </button>
            <button
              onClick={copyLogs}
              disabled={!data}
              title="Copy all"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden bg-zinc-950">
          {error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
              {String(error)}
            </div>
          ) : isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading logs…
            </div>
          ) : !data || data.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No log output.
            </div>
          ) : (
            <pre
              ref={scrollRef}
              className="h-full overflow-auto px-5 py-4 font-mono text-xs leading-relaxed text-zinc-100"
            >
              {data}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
