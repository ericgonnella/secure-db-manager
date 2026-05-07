import { useState, type ElementType } from "react";
import { useQuery } from "@tanstack/react-query";
import { DockerStatusCard } from "@/features/docker/docker-status-card";
import { CreateInstanceWizard } from "@/features/instances/create-instance-wizard";
import { listLocalInstances, listAuditLogs, type AuditEvent } from "@/lib/tauri";
import { Server, Globe, ShieldCheck, Plus, Play, Square, Trash2, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Activity helpers ───────────────────────────────────────────────────────

const ACTION_META: Record<string, { label: string; Icon: React.ElementType; color: string }> = {
  "instance.create": { label: "Created",  Icon: Plus,    color: "text-blue-500    bg-blue-500/10"    },
  "instance.start":  { label: "Started",  Icon: Play,    color: "text-emerald-500 bg-emerald-500/10" },
  "instance.stop":   { label: "Stopped",  Icon: Square,  color: "text-amber-500   bg-amber-500/10"  },
  "instance.delete": { label: "Deleted",  Icon: Trash2,  color: "text-red-500     bg-red-500/10"    },
};

function ActivityRow({ event }: { event: AuditEvent }) {
  const meta = ACTION_META[event.action] ?? { label: event.action, Icon: Server, color: "text-muted-foreground bg-muted" };
  const isError = event.outcome === "error";
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border last:border-0">
      <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", isError ? "bg-red-500/10 text-red-500" : meta.color)}>
        <meta.Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">
          <span className="font-medium">{event.instance_name}</span>
          <span className="text-muted-foreground"> — {meta.label}</span>
        </p>
        <p className="text-[11px] text-muted-foreground">
          {new Date(event.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>
      {isError
        ? <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
        : <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
      }
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: ElementType;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg",
            accent ?? "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="text-2xl font-semibold text-foreground">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function DashboardPage() {
  const [wizardOpen, setWizardOpen] = useState(false);
  const { data: instances = [] } = useQuery({
    queryKey: ["local-instances"],
    queryFn: listLocalInstances,
  });
  const { data: auditEvents = [] } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: listAuditLogs,
    refetchInterval: 10_000,
  });
  const instanceCount = instances.length;
  const recentEvents = auditEvents.slice(0, 6);
  return (
    <div className="space-y-6">
      {wizardOpen && (
        <CreateInstanceWizard onClose={() => setWizardOpen(false)} />
      )}
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Overview
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Monitor your database environments and infrastructure.
          </p>
        </div>
        <button
          onClick={() => setWizardOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
          <Plus className="h-4 w-4" />
          New Instance
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Local Instances"
          value={instanceCount}
          sub={instanceCount === 0 ? "No instances yet" : `${instanceCount} instance${instanceCount === 1 ? "" : "s"} running`}
          icon={Server}
          accent="bg-blue-500/10 text-blue-600 dark:text-blue-400"
        />
        <SummaryCard
          label="Remote Hosts"
          value={0}
          sub="No hosts registered"
          icon={Globe}
          accent="bg-violet-500/10 text-violet-600 dark:text-violet-400"
        />
        <SummaryCard
          label="Active Tunnels"
          value={0}
          sub="No active sessions"
          icon={ShieldCheck}
          accent="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        />
      </div>

      {/* Docker status */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Docker
          </h2>
          <DockerStatusCard />
        </div>

        {/* Recent activity */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Recent Activity
          </h2>
          <div className="rounded-xl border border-border bg-card p-5">
            {recentEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <Server className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">No activity yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Create a database instance to get started.
                </p>
              </div>
            ) : (
              <div>
                {recentEvents.map((e) => (
                  <ActivityRow key={e.id} event={e} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
