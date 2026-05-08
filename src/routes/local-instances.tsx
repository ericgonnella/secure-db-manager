import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  listLocalInstances,
  startLocalInstance,
  stopLocalInstance,
  deleteLocalInstance,
  getInstanceCredentials,
  setInstancePassword,
  setupPocketbaseSuperuser,
  resetInstancePassword,
  testConnection,
  type LocalInstance,
  type InstanceCredentials,
  type ConnectionTestResult,
} from "@/lib/tauri";
import { CreateInstanceWizard } from "@/features/instances/create-instance-wizard";
import { LogsViewer } from "@/features/instances/logs-viewer";
import { BackupManager } from "@/features/instances/backup-manager";
import { ExposeWizard } from "@/features/exposures/expose-wizard";
import { ConnectionStringsModal } from "@/features/instances/connection-strings";
import { StatusBadge } from "@/components/status-badge";
import { useProjects } from "@/lib/projects";
import {
  Server,
  Plus,
  Play,
  Square,
  Trash2,
  Copy,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Eye,
  EyeOff,
  Check,
  ScrollText,
  Activity,
  Archive,
  Network,
  Plug,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Instance row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Services that expose an HTTP admin UI. Maps service_type → { label, URL path }. */
const SERVICE_ADMIN: Record<string, { label: string; path: string }> = {
  pocketbase: { label: "Open admin UI", path: "/_/" },
  clickhouse:  { label: "Open Play UI",  path: "/play" },
};

/** Services that support in-container password reset via reset_instance_password. */
const SUPPORTS_PW_RESET = new Set([
  "postgres", "mysql", "mariadb", "redis", "mongodb", "clickhouse",
]);

function InstanceRow({ instance }: { instance: LocalInstance }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  const [showExpose, setShowExpose] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [healthResult, setHealthResult] = useState<ConnectionTestResult | null>(
    null
  );
  const [credentials, setCredentials] = useState<InstanceCredentials | null>(
    null
  );
  const [showPw, setShowPw] = useState(false);
  const [savedPwInput, setSavedPwInput] = useState("");
  const [showSavedPwInput, setShowSavedPwInput] = useState(false);
  const [pbEmail, setPbEmail] = useState(instance.username ?? "");
  const [pbPassword, setPbPassword] = useState("");
  const [pbShowPw, setPbShowPw] = useState(false);
  const [resetPw, setResetPw] = useState("");
  const [showResetPw, setShowResetPw] = useState(false);

  const startMut = useMutation({
    mutationFn: () => startLocalInstance(instance.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["local-instances"] }),
  });

  const stopMut = useMutation({
    mutationFn: () => stopLocalInstance(instance.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["local-instances"] }),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteLocalInstance(instance.id, true),
    onSuccess: () => {
      setConfirmDelete(false);
      queryClient.invalidateQueries({ queryKey: ["local-instances"] });
    },
  });

  const credsMut = useMutation({
    mutationFn: () => getInstanceCredentials(instance.id),
    onSuccess: (data) => {
      setCredentials(data);
      setShowPw(false);
      setExpanded(true);
      setShowSavedPwInput(false);
    },
  });

  const savePwMut = useMutation({
    mutationFn: (pw: string) => setInstancePassword(instance.id, pw),
    onSuccess: () => {
      setSavedPwInput("");
      credsMut.mutate();
    },
  });

  const pbSuperuserMut = useMutation({
    mutationFn: () => setupPocketbaseSuperuser(instance.id, pbEmail, pbPassword),
    onSuccess: () => {
      setPbPassword("");
      queryClient.invalidateQueries({ queryKey: ["local-instances"] });
    },
  });

  const healthMut = useMutation({
    mutationFn: () => testConnection(instance.id),
    onSuccess: (data) => {
      setHealthResult(data);
      setExpanded(true);
    },
    onError: (err) => {
      setHealthResult({
        healthy: false,
        latency_ms: 0,
        message: String(err),
      });
      setExpanded(true);
    },
  });

  const resetPwMut = useMutation({
    mutationFn: (pw: string) => resetInstancePassword(instance.id, pw),
    onSuccess: () => setResetPw(""),
  });

  const busy = startMut.isPending || stopMut.isPending || deleteMut.isPending;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Main row */}
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
          <Server className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground truncate">{instance.name}</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                envColor(instance.environment)
              )}
            >
              {instance.environment}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {instance.host}:{instance.port}
            {instance.db_name ? ` Â· ${instance.db_name}` : ""}
            {" Â· "}
            <span className="font-mono">{instance.container_name}</span>
          </p>
        </div>

        <StatusBadge variant={instance.status === "running" ? "success" : instance.status === "stopped" ? "error" : "warning"}>
          {instance.status}
        </StatusBadge>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            disabled={credsMut.isPending}
            onClick={() => credsMut.mutate()}
            title="Show credentials"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <KeyRound className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => setShowLogs(true)}
            title="View logs"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ScrollText className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => setShowBackups(true)}
            title="Backups"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Archive className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => setShowExpose(true)}
            title="Expose publicly"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Network className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => setShowConnect(true)}
            title="Connection strings"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plug className="h-3.5 w-3.5" />
          </button>

          <button
            disabled={healthMut.isPending || instance.status !== "running"}
            onClick={() => healthMut.mutate()}
            title={
              instance.status !== "running"
                ? "Start the instance to test"
                : "Test connection"
            }
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted disabled:opacity-40",
              healthResult?.healthy === true
                ? "text-emerald-500 hover:text-emerald-500"
                : healthResult?.healthy === false
                ? "text-destructive hover:text-destructive"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Activity
              className={cn(
                "h-3.5 w-3.5",
                healthMut.isPending && "animate-pulse"
              )}
            />
          </button>

          {SERVICE_ADMIN[instance.service_type] && (
            <button
              disabled={instance.status !== "running"}
              onClick={() =>
                openUrl(
                  `http://${instance.host}:${instance.port}${SERVICE_ADMIN[instance.service_type]!.path}`
                ).catch(() => {})
              }
              title={
                instance.status !== "running"
                  ? "Start the instance to open UI"
                  : SERVICE_ADMIN[instance.service_type]!.label
              }
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          )}

          {instance.status === "running" ? (
            <button
              disabled={busy}
              onClick={() => stopMut.mutate()}
              title="Stop"
              className="flex h-7 w-7 items-center justify-center rounded-md text-red-500 transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => startMut.mutate()}
              title="Start"
              className="flex h-7 w-7 items-center justify-center rounded-md text-emerald-500 transition-colors hover:bg-emerald-500/10 hover:text-emerald-600 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            title="Delete"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border bg-muted/30 px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
            {[
              ["Service", instance.service_type],
              ["Username", instance.username],
              ["Volume", instance.volume_name],
              ["Created", new Date(instance.created_at).toLocaleString()],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-mono text-foreground">{v}</span>
              </div>
            ))}
          </div>

          {healthResult && (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                healthResult.healthy
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                  : "border-destructive/30 bg-destructive/5 text-destructive"
              )}
            >
              <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {healthResult.healthy ? "Connection healthy" : "Connection failed"}
                  <span className="ml-2 font-mono text-[10px] opacity-70">
                    {healthResult.latency_ms}ms
                  </span>
                </p>
                <p className="mt-0.5 break-words font-mono opacity-80">
                  {healthResult.message}
                </p>
              </div>
            </div>
          )}

          {credentials ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Connection string</p>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                  <code className="flex-1 truncate font-mono text-xs">
                    {showPw
                      ? credentials.connection_uri
                      : credentials.connection_uri.replace(
                          credentials.password,
                          "\u2022".repeat(8)
                        )}
                  </code>
                  <button
                    onClick={() => setShowPw((v) => !v)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    title={showPw ? "Hide password" : "Show password"}
                  >
                    {showPw ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <CopyButton text={credentials.connection_uri} />
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Password</p>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                  <code className="flex-1 truncate font-mono text-xs">
                    {showPw ? credentials.password : "\u2022".repeat(16)}
                  </code>
                  <CopyButton text={credentials.password} />
                </div>
              </div>
            </div>
          ) : (
            <button
              disabled={credsMut.isPending}
              onClick={() => credsMut.mutate()}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <KeyRound className="h-3.5 w-3.5" />
              {credsMut.isPending ? "Loading\u2026" : "Reveal connection details"}
            </button>
          )}

          {credsMut.isError && String(credsMut.error) === "CREDENTIAL_NOT_FOUND" ? (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                No password found in the system keyring for this instance. Enter
                the password to store it securely.
              </p>
              {showSavedPwInput ? (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={savedPwInput}
                    onChange={(e) => setSavedPwInput(e.target.value)}
                    placeholder="Enter passwordâ€¦"
                    className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <button
                    disabled={savePwMut.isPending || savedPwInput.length < 8}
                    onClick={() => savePwMut.mutate(savedPwInput)}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {savePwMut.isPending ? "Savingâ€¦" : "Save & reveal"}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowSavedPwInput(true)}
                  className="rounded-md border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                >
                  Enter password
                </button>
              )}
              {savePwMut.isError && (
                <p className="text-xs text-destructive">{String(savePwMut.error)}</p>
              )}
            </div>
          ) : credsMut.isError ? (
            <p className="text-xs text-destructive">
              {String(credsMut.error)}
            </p>
          ) : null}
          {(startMut.isError || stopMut.isError) && (
            <p className="text-xs text-destructive">
              {String(startMut.error ?? stopMut.error)}
            </p>
          )}

          {/* PocketBase superuser setup panel */}
          {instance.service_type === "pocketbase" && (
            <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-3">
              <p className="text-xs font-medium text-foreground">PocketBase admin credentials</p>
              <p className="text-xs text-muted-foreground">
                Set or reset the superuser. Runs{" "}
                <code className="font-mono text-[10px]">pocketbase superuser upsert</code>{" "}
                inside the container â€” the instance must be running.
              </p>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={pbEmail}
                  onChange={(e) => setPbEmail(e.target.value)}
                  placeholder="admin@example.com"
                  className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
                <div className="relative">
                  <input
                    type={pbShowPw ? "text" : "password"}
                    value={pbPassword}
                    onChange={(e) => setPbPassword(e.target.value)}
                    placeholder="Password (min 10 chars)"
                    className="w-48 rounded-md border border-border bg-background px-2.5 py-1.5 pr-8 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <button
                    type="button"
                    onClick={() => setPbShowPw((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {pbShowPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <button
                  disabled={
                    pbSuperuserMut.isPending ||
                    instance.status !== "running" ||
                    !pbEmail.includes("@") ||
                    pbPassword.length < 10
                  }
                  onClick={() => pbSuperuserMut.mutate()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {pbSuperuserMut.isPending ? "Settingâ€¦" : "Set superuser"}
                </button>
              </div>
              {pbSuperuserMut.isSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  Superuser updated successfully.
                </p>
              )}
              {pbSuperuserMut.isError && (
                <p className="text-xs text-destructive break-words">
                  {String(pbSuperuserMut.error)}
                </p>
              )}
              {instance.status !== "running" && (
                <p className="text-xs text-muted-foreground">Start the instance first.</p>
              )}
            </div>
          )}

          {/* Admin password reset — postgres, mysql, mariadb, redis, mongodb, clickhouse */}
          {SUPPORTS_PW_RESET.has(instance.service_type) && (
            <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-3">
              <p className="text-xs font-medium text-foreground">Reset admin password</p>
              <p className="text-xs text-muted-foreground">
                Runs the appropriate command inside the container to update the{" "}
                <span className="font-mono">{instance.service_type}</span> password and syncs
                the stored credential.
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showResetPw ? "text" : "password"}
                    value={resetPw}
                    onChange={(e) => setResetPw(e.target.value)}
                    placeholder="New password (min 8 chars)"
                    className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 pr-8 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPw((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showResetPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <button
                  disabled={
                    resetPwMut.isPending ||
                    instance.status !== "running" ||
                    resetPw.length < 8
                  }
                  onClick={() => resetPwMut.mutate(resetPw)}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {resetPwMut.isPending ? "Resetting…" : "Reset password"}
                </button>
              </div>
              {resetPwMut.isSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  Password reset successfully. Stored credential updated.
                </p>
              )}
              {resetPwMut.isError && (
                <p className="text-xs text-destructive break-words">
                  {String(resetPwMut.error)}
                </p>
              )}
              {instance.status !== "running" && (
                <p className="text-xs text-muted-foreground">Start the instance first.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Confirm delete */}
      {confirmDelete && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-5 py-3 flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">
            Delete <strong>{instance.name}</strong> and its volume? This cannot be undone.
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
              {deleteMut.isPending ? "Deletingâ€¦" : "Delete"}
            </button>
          </div>
        </div>
      )}

      {showLogs && (
        <LogsViewer instance={instance} onClose={() => setShowLogs(false)} />
      )}

      {showBackups && (
        <BackupManager
          instance={instance}
          onClose={() => setShowBackups(false)}
        />
      )}

      {showExpose && (
        <ExposeWizard
          instance={instance}
          onClose={() => setShowExpose(false)}
        />
      )}

      {showConnect && (
        <ConnectionStringsModal
          instance={instance}
          onClose={() => setShowConnect(false)}
        />
      )}
    </div>
  );
}

// â”€â”€ Page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function LocalInstancesPage() {
  const [wizardOpen, setWizardOpen] = useState(false);
  const { currentProjectId, projects } = useProjects();
  const currentProject = projects.find((p) => p.id === currentProjectId);

  const { data: allInstances = [], isLoading } = useQuery({
    queryKey: ["local-instances"],
    queryFn: listLocalInstances,
  });

  // Filter instances to the selected project
  const instances = allInstances.filter(
    (i) => (i.project_id ?? "default") === currentProjectId
  );

  return (
    <div className="space-y-6">
      {wizardOpen && (
        <CreateInstanceWizard
          onClose={() => setWizardOpen(false)}
          projectId={currentProjectId}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {currentProject?.name ?? "Default Project"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Docker-managed database containers running on this machine.
          </p>
        </div>
        <button
          onClick={() => setWizardOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Instance
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          Loadingâ€¦
        </div>
      ) : instances.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card py-16 text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Server className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground">No instances yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create a database instance to get started.
          </p>
          <button
            onClick={() => setWizardOpen(true)}
            className="mt-4 flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            New Instance
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {instances.map((instance) => (
            <InstanceRow key={instance.id} instance={instance} />
          ))}
        </div>
      )}
    </div>
  );
}
