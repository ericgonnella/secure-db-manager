import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listAuditLogs, type AuditEvent } from "@/lib/tauri";
import {
  ClipboardList,
  Plus,
  Play,
  Square,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Filter,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Helpers ────────────────────────────────────────────────────────────────

const ACTION_META: Record<
  string,
  { label: string; Icon: React.ElementType; color: string }
> = {
  "instance.create": {
    label: "Created",
    Icon: Plus,
    color: "text-blue-500 bg-blue-500/10",
  },
  "instance.start": {
    label: "Started",
    Icon: Play,
    color: "text-emerald-500 bg-emerald-500/10",
  },
  "instance.stop": {
    label: "Stopped",
    Icon: Square,
    color: "text-amber-500 bg-amber-500/10",
  },
  "instance.delete": {
    label: "Deleted",
    Icon: Trash2,
    color: "text-red-500 bg-red-500/10",
  },
};

function actionMeta(action: string) {
  return (
    ACTION_META[action] ?? {
      label: action,
      Icon: ClipboardList,
      color: "text-muted-foreground bg-muted",
    }
  );
}

function envColor(env: string) {
  switch (env) {
    case "production":
      return "text-red-500 bg-red-500/10";
    case "staging":
      return "text-amber-500 bg-amber-500/10";
    case "testing":
      return "text-blue-500 bg-blue-500/10";
    default:
      return "text-emerald-500 bg-emerald-500/10";
  }
}

function formatTs(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ── Row ────────────────────────────────────────────────────────────────────

function EventRow({ event }: { event: AuditEvent }) {
  const meta = actionMeta(event.action);
  const isError = event.outcome === "error";

  return (
    <div
      className={cn(
        "flex items-start gap-4 rounded-xl border px-5 py-4 transition-colors",
        isError
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-card"
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          isError ? "bg-red-500/10 text-red-500" : meta.color
        )}
      >
        <meta.Icon className="h-4 w-4" />
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-sm text-foreground">
            {event.instance_name}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
              envColor(event.environment)
            )}
          >
            {event.environment}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wider">
            {event.service_type}
          </span>
        </div>
        {event.detail && (
          <p className="text-xs text-muted-foreground truncate">{event.detail}</p>
        )}
      </div>

      {/* Right side */}
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-1.5">
          {isError ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          )}
          <span
            className={cn(
              "text-xs font-medium",
              isError ? "text-destructive" : "text-foreground"
            )}
          >
            {meta.label}
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {formatTs(event.timestamp)}
        </span>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

type FilterAction = "all" | keyof typeof ACTION_META;

export function AuditLogsPage() {
  const [filter, setFilter] = useState<FilterAction>("all");

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: listAuditLogs,
    refetchInterval: 10_000,
  });

  const filtered =
    filter === "all" ? events : events.filter((e) => e.action === filter);

  const FILTERS: { value: FilterAction; label: string }[] = [
    { value: "all", label: "All" },
    { value: "instance.create", label: "Created" },
    { value: "instance.start", label: "Started" },
    { value: "instance.stop", label: "Stopped" },
    { value: "instance.delete", label: "Deleted" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Audit Logs
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A record of every action taken on database instances.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          <span>{filtered.length} event{filtered.length !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {f.label}
            {f.value !== "all" && (
              <span className="ml-1.5 opacity-60">
                {events.filter((e) => e.action === f.value).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card py-16 text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <ClipboardList className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground">No events yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Events will appear here after you create or manage instances.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
