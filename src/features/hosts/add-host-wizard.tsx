import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjects } from "@/lib/projects";
import {
  addRemoteHost,
  type AddRemoteHostInput,
  type RemoteAuthType,
  type ServiceType,
  type SslMode,
} from "@/lib/tauri";

const SERVICES: { id: ServiceType; label: string; defaultPort: number; hasDb: boolean }[] = [
  { id: "postgres", label: "PostgreSQL", defaultPort: 5432, hasDb: true },
  { id: "mysql", label: "MySQL", defaultPort: 3306, hasDb: true },
  { id: "mariadb", label: "MariaDB", defaultPort: 3306, hasDb: true },
  { id: "redis", label: "Redis", defaultPort: 6379, hasDb: false },
  { id: "mongodb", label: "MongoDB", defaultPort: 27017, hasDb: true },
  { id: "clickhouse", label: "ClickHouse", defaultPort: 8123, hasDb: true },
  { id: "pocketbase", label: "PocketBase", defaultPort: 8090, hasDb: false },
];

type Environment = "development" | "testing" | "staging" | "production";

interface Props {
  onClose: () => void;
}

export function AddHostWizard({ onClose }: Props) {
  const queryClient = useQueryClient();
  const { currentProjectId } = useProjects();

  const [serviceType, setServiceType] = useState<ServiceType>("postgres");
  const [environment, setEnvironment] = useState<Environment>("production");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [dbName, setDbName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sslMode, setSslMode] = useState<SslMode>("require");
  const [authType, setAuthType] = useState<RemoteAuthType>("password");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUser, setSshUser] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [notes, setNotes] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const service = SERVICES.find((s) => s.id === serviceType) ?? SERVICES[0];

  function onServiceChange(s: ServiceType) {
    setServiceType(s);
    const def = SERVICES.find((x) => x.id === s)!;
    setPort(String(def.defaultPort));
    if (!def.hasDb) setDbName("");
    if (s === "redis" || s === "pocketbase") setSslMode("disable");
    else if (sslMode === "disable") setSslMode("require");
  }

  const mutation = useMutation({
    mutationFn: (input: AddRemoteHostInput) => addRemoteHost(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["remote-hosts"] });
      onClose();
    },
    onError: (err: unknown) => setError(String(err)),
  });

  function submit() {
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    if (!host.trim()) return setError("Host is required.");
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)
      return setError("Port must be between 1 and 65535.");
    if (!password) return setError("Password is required.");
    if (password.length < 4) return setError("Password is too short.");
    if (authType === "ssh-tunnel" && (!sshHost.trim() || !sshUser.trim()))
      return setError("SSH host and user are required for SSH tunnel.");

    const sshPortNum = sshPort ? Number(sshPort) : null;
    if (
      authType === "ssh-tunnel" &&
      sshPortNum !== null &&
      (!Number.isInteger(sshPortNum) || sshPortNum < 1 || sshPortNum > 65535)
    )
      return setError("SSH port must be between 1 and 65535.");

    mutation.mutate({
      name: name.trim(),
      service_type: serviceType,
      environment,
      host: host.trim(),
      port: portNum,
      db_name: service.hasDb && dbName.trim() ? dbName.trim() : null,
      username: username.trim(),
      password,
      ssl_mode: sslMode,
      auth_type: authType,
      ssh_host: authType === "ssh-tunnel" ? sshHost.trim() : null,
      ssh_port: authType === "ssh-tunnel" ? sshPortNum : null,
      ssh_user: authType === "ssh-tunnel" ? sshUser.trim() : null,
      ssh_key_path:
        authType === "ssh-tunnel" && sshKeyPath.trim() ? sshKeyPath.trim() : null,
      notes: notes.trim() || null,
      project_id: currentProjectId,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Add Remote Host
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {/* Service + environment */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Service">
              <select
                value={serviceType}
                onChange={(e) => onServiceChange(e.target.value as ServiceType)}
                className={inputCls}
              >
                {SERVICES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Environment">
              <select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as Environment)}
                className={inputCls}
              >
                <option value="development">Development</option>
                <option value="testing">Testing</option>
                <option value="staging">Staging</option>
                <option value="production">Production</option>
              </select>
            </Field>
          </div>

          <Field label="Display name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="prod-postgres-eu"
              className={inputCls}
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label="Host">
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="db.internal.example.com"
                className={inputCls}
              />
            </Field>
            <Field label="Port">
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))}
                className={inputCls}
                inputMode="numeric"
              />
            </Field>
          </div>

          {service.hasDb && (
            <Field label="Database name (optional)">
              <input
                value={dbName}
                onChange={(e) => setDbName(e.target.value)}
                placeholder="appdb"
                className={inputCls}
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Username">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={serviceType === "redis" ? "(optional)" : "postgres"}
                className={inputCls}
              />
            </Field>
            <Field label="Password">
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={cn(inputCls, "pr-9")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          </div>

          <Field label="TLS / SSL mode">
            <select
              value={sslMode}
              onChange={(e) => setSslMode(e.target.value as SslMode)}
              className={inputCls}
            >
              <option value="disable">Disable</option>
              <option value="require">Require</option>
              <option value="verify-ca">Verify CA</option>
              <option value="verify-full">Verify Full</option>
            </select>
          </Field>

          <Field label="Authentication">
            <div className="flex gap-2">
              {(["password", "ssh-tunnel"] as RemoteAuthType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAuthType(t)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    authType === t
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  )}
                >
                  {t === "password" ? "Direct (Password)" : "SSH Tunnel"}
                </button>
              ))}
            </div>
          </Field>

          {authType === "ssh-tunnel" && (
            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <Field label="SSH host">
                  <input
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="bastion.example.com"
                    className={inputCls}
                  />
                </Field>
                <Field label="SSH port">
                  <input
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value.replace(/[^\d]/g, ""))}
                    className={inputCls}
                    inputMode="numeric"
                  />
                </Field>
              </div>
              <Field label="SSH user">
                <input
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label="SSH key path (optional)">
                <input
                  value={sshKeyPath}
                  onChange={(e) => setSshKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  className={inputCls}
                />
              </Field>
            </div>
          )}

          <Field label="Notes (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={cn(inputCls, "resize-none")}
            />
          </Field>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={mutation.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {mutation.isPending ? "Saving…" : "Save host"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
