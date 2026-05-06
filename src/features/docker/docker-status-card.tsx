import { useQuery } from "@tanstack/react-query";
import { detectDocker, type DockerStatus, type DockerMode, type SetupStep } from "@/lib/tauri";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import {
  Container,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Terminal,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useState } from "react";

// ── Mode label helpers ─────────────────────────────────────────────────────

const MODE_LABEL: Record<DockerMode, string> = {
  native: "Docker Desktop / Native",
  wsl2: "Docker Engine (WSL2)",
  none: "Not found",
};

const MODE_DESC: Record<DockerMode, string> = {
  native: "Docker CLI found in system PATH",
  wsl2: "Docker Engine running inside WSL2 — no Desktop required",
  none: "Docker was not detected",
};

// ── Sub-components ─────────────────────────────────────────────────────────

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail?: string | null;
}) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      )}
      <div className="min-w-0">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {detail && (
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        )}
      </div>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="group relative mt-1 rounded-md border border-border bg-muted/60 px-3 py-2">
      <pre className="font-mono text-xs text-foreground whitespace-pre-wrap break-all pr-12">{code}</pre>
      <button
        onClick={copy}
        className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function SetupGuide({ steps }: { steps: SetupStep[] }) {
  const [open, setOpen] = useState(true);
  if (steps.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="text-sm font-medium text-foreground">
            Setup required
          </span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-amber-500/20 px-4 pb-4 pt-3">
          {steps.map((s, i) => (
            <div key={i}>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="mr-1.5 font-semibold text-foreground">
                  {i + 1}.
                </span>
                {s.text}
              </p>
              {s.code && <CodeBlock code={s.code} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-9 w-9 rounded-lg bg-muted animate-pulse" />
        <div className="space-y-1.5">
          <div className="h-4 w-32 rounded bg-muted animate-pulse" />
          <div className="h-3 w-48 rounded bg-muted animate-pulse" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-3 w-full rounded bg-muted animate-pulse" />
        <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
      </div>
    </div>
  );
}

// ── Main card ──────────────────────────────────────────────────────────────

export function DockerStatusCard() {
  const { data, isLoading, isError, refetch, isFetching } =
    useQuery<DockerStatus>({
      queryKey: ["docker-status"],
      queryFn: detectDocker,
      retry: 1,
      staleTime: 10_000,
    });

  if (isLoading) return <Skeleton />;

  const allGood = data?.cli_available && data?.daemon_running;
  const mode = data?.mode ?? "none";

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-5 transition-colors",
        allGood ? "border-border" : "border-amber-500/30 bg-amber-500/5"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg",
              allGood
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            )}
          >
            {mode === "wsl2" ? (
              <Terminal className="h-5 w-5" />
            ) : (
              <Container className="h-5 w-5" />
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {MODE_LABEL[mode]}
            </h3>
            <p className="text-xs text-muted-foreground">{MODE_DESC[mode]}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {allGood ? (
            <StatusBadge variant="success">Ready</StatusBadge>
          ) : mode === "none" ? (
            <StatusBadge variant="error">Not installed</StatusBadge>
          ) : (
            <StatusBadge variant="warning">Daemon stopped</StatusBadge>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh Docker status"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isFetching && "animate-spin")}
            />
          </button>
        </div>
      </div>

      {/* Status rows */}
      {mode !== "none" && (
        <div className="divide-y divide-border/60">
          <StatusRow
            label="Docker CLI"
            ok={data?.cli_available ?? false}
            detail={
              data?.cli_available
                ? data.cli_version
                : "Not found in PATH or WSL2"
            }
          />
          <StatusRow
            label="Docker Daemon"
            ok={data?.daemon_running ?? false}
            detail={
              data?.daemon_running
                ? mode === "wsl2"
                  ? "Daemon running inside WSL2"
                  : "Daemon is reachable"
                : (data?.daemon_error ?? "Not reachable")
            }
          />
        </div>
      )}

      {/* Setup guide */}
      {!allGood && data?.setup_steps && data.setup_steps.length > 0 && (
        <SetupGuide steps={data.setup_steps} />
      )}

      {isError && (
        <div className="mt-4 flex gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <p className="text-xs text-muted-foreground">
            Failed to query Docker status. Is the Tauri backend running?
          </p>
        </div>
      )}
    </div>
  );
}


