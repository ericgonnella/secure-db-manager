import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Network,
  Globe,
  Cloud,
  Zap,
  Lock,
  Link,
  Trash2,
  Copy,
  Check,
  Server,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import {
  listExposures,
  listLocalInstances,
  listWebApps,
  removeExposure,
  reprovisionCloudflareExposures,
  regenerateCloudflareExposure,
  type Exposure,
  type LocalInstance,
  type WebApp,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

function methodMeta(method: string) {
  switch (method) {
    case "direct":
      return { label: "Direct", Icon: Globe, color: "bg-blue-500/10 text-blue-500" };
    case "cloudflare":
      return { label: "Cloudflare", Icon: Cloud, color: "bg-orange-500/10 text-orange-500" };
    case "ngrok":
      return { label: "ngrok", Icon: Zap, color: "bg-emerald-500/10 text-emerald-500" };
    case "nginx":
      return { label: "TLS Proxy", Icon: Lock, color: "bg-purple-500/10 text-purple-500" };
    case "localtunnel":
      return { label: "localtunnel", Icon: Link, color: "bg-sky-500/10 text-sky-500" };
    default:
      return { label: method, Icon: Network, color: "bg-muted text-muted-foreground" };
  }
}

function statusColor(status: string, method?: string) {
  if (status === "pending" && method === "cloudflare") {
    return "text-amber-600 bg-amber-500/10 dark:text-amber-400";
  }
  switch (status) {
    case "active":
      return "text-emerald-500 bg-emerald-500/10";
    case "error":
      return "text-red-500 bg-red-500/10";
    default:
      return "text-muted-foreground bg-muted";
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-muted-foreground hover:text-foreground"
      title="Copy"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function ExposureRow({
  exposure,
  instance,
  webApp,
}: {
  exposure: Exposure;
  instance: LocalInstance | undefined;
  webApp: WebApp | undefined;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = methodMeta(exposure.method);
  const isWebApp = exposure.target_type === "web_app";
  const displayName = instance?.name ?? webApp?.name ?? exposure.instance_id;

  const removeMutation = useMutation({
    mutationFn: () => removeExposure(exposure.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exposures"] });
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: () => regenerateCloudflareExposure(exposure.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exposures"] });
    },
  });

  const endpoint = exposure.external_endpoint ?? "(pending)";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center">
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
          meta.color
        )}
      >
        <meta.Icon className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {displayName}
          </span>
          {isWebApp && (
            <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-purple-500">
              Web App
            </span>
          )}
          <span
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              statusColor(exposure.status, exposure.method)
            )}
          >
            {exposure.status === "pending" && exposure.method === "cloudflare" ? (
              <>
                <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                Reconnecting
              </>
            ) : (
              exposure.status
            )}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {meta.label}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <code className="truncate font-mono text-foreground">{endpoint}</code>
          {exposure.external_endpoint && (
            <CopyButton text={exposure.external_endpoint} />
          )}
        </div>
        {exposure.error && (
          <p className="mt-1 text-xs text-red-500">{exposure.error}</p>
        )}
        {regenerateMutation.isError && (
          <p className="mt-1 text-xs text-red-500">
            Regenerate failed: {String(regenerateMutation.error)}
          </p>
        )}
        {regenerateMutation.isPending && (
          <p className="mt-1 text-xs text-orange-500">Getting a new Cloudflare URL…</p>
        )}
      </div>

      <div className="flex items-center gap-1">
        {exposure.external_endpoint?.startsWith("http") && (
          <a
            href={exposure.external_endpoint}
            target="_blank"
            rel="noreferrer"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Open in browser"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        {exposure.method === "cloudflare" && (
          <button
            onClick={() => regenerateMutation.mutate()}
            disabled={regenerateMutation.isPending}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-orange-500/10 hover:text-orange-500 disabled:opacity-40"
            title="Get a new Cloudflare URL"
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                regenerateMutation.isPending && "animate-spin"
              )}
            />
          </button>
        )}
        {confirmDelete ? (
          <>
            <button
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
              className="rounded-md bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-500 hover:bg-red-500/20 disabled:opacity-50"
            >
              {removeMutation.isPending ? "Removing…" : "Confirm"}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
            title="Remove exposure"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function ExposuresPage() {
  const queryClient = useQueryClient();
  const { data: exposures = [], isLoading } = useQuery({
    queryKey: ["exposures"],
    queryFn: listExposures,
  });
  const { data: instances = [] } = useQuery({
    queryKey: ["local-instances"],
    queryFn: listLocalInstances,
  });
  const { data: webApps = [] } = useQuery({
    queryKey: ["web-apps"],
    queryFn: listWebApps,
  });

  // Auto-reprovision cloudflare exposures that are "pending" (e.g. after app restart),
  // but only for instances that are currently running.
  useEffect(() => {
    if (exposures.length === 0 || instances.length === 0) return;
    const runningIds = new Set(
      instances.filter((i) => i.status === "running").map((i) => i.id)
    );
    const pendingCloudflare = exposures.filter(
      (e) => e.method === "cloudflare" && e.status === "pending" && runningIds.has(e.instance_id)
    );
    if (pendingCloudflare.length === 0) return;
    // Group by instance_id and reprovision each
    const instanceIds = [...new Set(pendingCloudflare.map((e) => e.instance_id))];
    Promise.all(instanceIds.map((id) => reprovisionCloudflareExposures(id))).then(
      () => queryClient.invalidateQueries({ queryKey: ["exposures"] })
    );
  }, [exposures, instances, queryClient]);

  const instanceMap = useMemo(
    () => new Map(instances.map((i) => [i.id, i])),
    [instances]
  );
  const webAppMap = useMemo(
    () => new Map(webApps.map((w) => [w.id, w])),
    [webApps]
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Public Exposures
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage public access for your databases &mdash; direct connections, tunnels, and TLS proxies.
        </p>
      </header>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Server className="h-4 w-4 animate-pulse" />
          Loading exposures…
        </div>
      ) : exposures.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Network className="h-5 w-5" />
          </div>
          <h3 className="mt-3 text-sm font-medium text-foreground">
            No active exposures
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Open a local instance and click <span className="font-medium">Expose</span> to make
            it reachable from the internet.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {exposures.map((e) => (
            <ExposureRow
              key={e.id}
              exposure={e}
              instance={instanceMap.get(e.instance_id)}
              webApp={webAppMap.get(e.instance_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
