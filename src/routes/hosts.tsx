import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Server,
  Plus,
  Trash2,
  Copy,
  Eye,
  EyeOff,
  Check,
  Activity,
  ChevronDown,
  ChevronUp,
  KeyRound,
  ShieldCheck,
  Network,
} from "lucide-react";
import {
  listRemoteHosts,
  deleteRemoteHost,
  getRemoteHostCredentials,
  testRemoteConnection,
  type RemoteHost,
  type RemoteHostCredentials,
  type RemoteConnectionResult,
} from "@/lib/tauri";
import { AddHostWizard } from "@/features/hosts/add-host-wizard";
import { StatusBadge } from "@/components/status-badge";
import { useProjects } from "@/lib/projects";
import { cn } from "@/lib/utils";

// ── Helpers ────────────────────────────────────────────────────────────────

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

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-muted-foreground hover:text-foreground"
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

// ── Row ────────────────────────────────────────────────────────────────────

function HostRow({ host }: { host: RemoteHost }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [credentials, setCredentials] = useState<RemoteHostCredentials | null>(
    null
  );
  const [showPw, setShowPw] = useState(false);
  const [healthResult, setHealthResult] =
    useState<RemoteConnectionResult | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => deleteRemoteHost(host.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["remote-hosts"] });
    },
  });

  const credsMutation = useMutation({
    mutationFn: () => getRemoteHostCredentials(host.id),
    onSuccess: (data) => setCredentials(data),
  });

  const testMutation = useMutation({
    mutationFn: () => testRemoteConnection(host.id),
    onSuccess: (r) => setHealthResult(r),
  });

  const isSshTunnel = host.auth_type === "ssh-tunnel";

  return (
    <div className="rounded-lg border border-border bg-card transition-colors hover:border-border/80">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Server className="h-4 w-4 text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {host.name}
            </span>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {host.service_type}
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                envColor(host.environment)
              )}
            >
              {host.environment}
            </span>
            {isSshTunnel && (
              <span className="flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-purple-500">
                <Network className="h-2.5 w-2.5" /> SSH
              </span>
            )}
            {host.ssl_mode !== "disable" && (
              <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-500">
                <ShieldCheck className="h-2.5 w-2.5" /> {host.ssl_mode}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {host.host}:{host.port}
            {host.db_name ? ` · ${host.db_name}` : ""} · {host.username}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {healthResult ? (
            <StatusBadge variant={healthResult.healthy ? "success" : "error"}>
              {healthResult.healthy ? "Reachable" : "Unreachable"}
            </StatusBadge>
          ) : (
            <StatusBadge variant="muted">Unknown</StatusBadge>
          )}

          <button
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
            className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
            title="Test connection"
          >
            <Activity className="h-3.5 w-3.5" />
            {testMutation.isPending ? "Testing…" : "Test"}
          </button>

          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border bg-muted/20 px-4 py-4">
          {/* Health result detail */}
          {healthResult && (
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-xs",
                healthResult.healthy
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-red-500/30 bg-red-500/10 text-red-500"
              )}
            >
              <div className="font-medium">
                {healthResult.healthy ? "Connection OK" : "Connection failed"}{" "}
                <span className="text-muted-foreground">
                  ({healthResult.latency_ms} ms)
                </span>
              </div>
              <div className="mt-0.5 text-muted-foreground">
                {healthResult.message}
              </div>
            </div>
          )}

          {/* Credentials panel */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Credentials
              </span>
              {credentials ? (
                <button
                  onClick={() => {
                    setCredentials(null);
                    setShowPw(false);
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Hide
                </button>
              ) : (
                <button
                  onClick={() => credsMutation.mutate()}
                  disabled={credsMutation.isPending}
                  className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {credsMutation.isPending ? "Loading…" : "Reveal"}
                </button>
              )}
            </div>

            {credsMutation.isError && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                {String(credsMutation.error)}
              </div>
            )}

            {credentials && (
              <div className="space-y-2 rounded-md border border-border bg-card p-3">
                <CredField label="Host" value={credentials.host} />
                <CredField label="Port" value={String(credentials.port)} />
                <CredField label="User" value={credentials.username} />
                {credentials.db_name && (
                  <CredField label="Database" value={credentials.db_name} />
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Password
                  </span>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs text-foreground">
                      {showPw ? credentials.password : "••••••••••"}
                    </code>
                    <button
                      onClick={() => setShowPw((v) => !v)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {showPw ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <CopyButton text={credentials.password} />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    URI
                  </span>
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="truncate font-mono text-xs text-foreground">
                      {credentials.connection_uri}
                    </code>
                    <CopyButton text={credentials.connection_uri} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* SSH tunnel detail */}
          {isSshTunnel && (
            <div className="rounded-md border border-border bg-card p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                SSH Tunnel
              </div>
              <div className="space-y-1.5 text-xs text-foreground">
                <div>
                  <span className="text-muted-foreground">Bastion: </span>
                  {host.ssh_user}@{host.ssh_host}:{host.ssh_port ?? 22}
                </div>
                {host.ssh_key_path && (
                  <div>
                    <span className="text-muted-foreground">Key: </span>
                    <code className="font-mono">{host.ssh_key_path}</code>
                  </div>
                )}
                <div className="text-[11px] text-muted-foreground">
                  Tunnel orchestration coming in Phase 2 (Access Broker).
                </div>
              </div>
            </div>
          )}

          {host.notes && (
            <div className="rounded-md border border-border bg-card p-3 text-xs text-foreground">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Notes
              </div>
              {host.notes}
            </div>
          )}

          {/* Danger zone */}
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            {confirmDelete ? (
              <>
                <span className="text-xs text-muted-foreground">
                  Delete this host? Saved credentials will be removed.
                </span>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-500/20 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CredField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <code className="font-mono text-xs text-foreground">{value}</code>
        <CopyButton text={value} />
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function RemoteHostsPage() {
  const { currentProjectId } = useProjects();
  const [showWizard, setShowWizard] = useState(false);

  const { data: hosts = [], isLoading, error } = useQuery({
    queryKey: ["remote-hosts"],
    queryFn: listRemoteHosts,
  });

  const filtered = hosts.filter((h) => h.project_id === currentProjectId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Remote Hosts
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect to existing databases — credentials are encrypted in your OS
            keyring.
          </p>
        </div>
        <button
          onClick={() => setShowWizard(true)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          Add host
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          Failed to load hosts: {String(error)}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-xl border border-border bg-card py-16 text-center text-sm text-muted-foreground">
          Loading hosts…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card py-16 text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Server className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground">
            No remote hosts yet
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add a connection to a remote database to manage it from here.
          </p>
          <button
            onClick={() => setShowWizard(true)}
            className="mt-4 flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Add your first host
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((h) => (
            <HostRow key={h.id} host={h} />
          ))}
        </div>
      )}

      {showWizard && <AddHostWizard onClose={() => setShowWizard(false)} />}
    </div>
  );
}
