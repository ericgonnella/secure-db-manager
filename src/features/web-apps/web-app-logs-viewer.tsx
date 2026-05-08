import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, RefreshCw, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { getWebAppLogs, type WebApp } from "@/lib/tauri";

const TAIL_OPTIONS = [100, 200, 500, 1000, 2000] as const;

interface Props {
  webApp: WebApp;
  onClose: () => void;
}

export function WebAppLogsViewer({ webApp, onClose }: Props) {
  const [tail, setTail] = useState<number>(200);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLPreElement>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["web-app-logs", webApp.id, tail],
    queryFn: () => getWebAppLogs(webApp.id, tail),
    refetchInterval: autoRefresh ? 2000 : false,
    refetchOnWindowFocus: false,
  });

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold">Logs</h2>
            <p className="text-xs text-muted-foreground">{webApp.name}</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={tail}
              onChange={(e) => setTail(parseInt(e.target.value, 10))}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
            >
              {TAIL_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  Last {n}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto
            </label>
            <button
              onClick={() => refetch()}
              className={cn(
                "text-muted-foreground hover:text-foreground",
                isFetching && "animate-spin",
              )}
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={copyLogs}
              className="text-muted-foreground hover:text-foreground"
              title="Copy"
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden bg-black/40 p-3">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : error ? (
            <div className="text-sm text-red-400">{String(error)}</div>
          ) : (
            <pre
              ref={scrollRef}
              className="h-full overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-emerald-200/90"
            >
              {data || "(no output)"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
