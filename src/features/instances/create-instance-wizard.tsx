import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  X,
  Database,
  ChevronRight,
  ChevronLeft,
  Check,
  RefreshCw,
  Eye,
  EyeOff,
  Copy,
} from "lucide-react";
import {
  createLocalInstance,
  type CreateInstanceInput,
  type ServiceType,
} from "@/lib/tauri";

// ── Types ─────────────────────────────────────────────────────────────────

type Environment = "development" | "testing" | "staging" | "production";

interface WizardState {
  serviceType: ServiceType;
  environment: Environment;
  name: string;
  version: string;
  port: string;
  dbName: string;
  username: string;
  password: string;
}

interface ServiceOption {
  id: ServiceType;
  label: string;
  versions: string[];
  defaultPort: number;
  hasDatabase: boolean;
  hasAuth: boolean;
  /** URL scheme used in the connection string */
  scheme: string;
  /** HTTP-based service (e.g. PocketBase) — no traditional SQL connection string */
  isHttpService?: boolean;
  /** Service creates an admin/superuser via CLI instead of env-var credentials */
  requiresSuperuser?: boolean;
}

const SERVICE_OPTIONS: ServiceOption[] = [
  {
    id: "postgres",
    label: "PostgreSQL",
    versions: ["17", "16", "15", "14"],
    defaultPort: 5432,
    hasDatabase: true,
    hasAuth: true,
    scheme: "postgresql",
  },
  {
    id: "mysql",
    label: "MySQL",
    versions: ["9.0", "8.4", "8.0"],
    defaultPort: 3306,
    hasDatabase: true,
    hasAuth: true,
    scheme: "mysql",
  },
  {
    id: "mariadb",
    label: "MariaDB",
    versions: ["11.4", "10.11", "10.6"],
    defaultPort: 3307,
    hasDatabase: true,
    hasAuth: true,
    scheme: "mysql",
  },
  {
    id: "redis",
    label: "Redis",
    versions: ["7.4", "7.2", "6.2"],
    defaultPort: 6379,
    hasDatabase: false,
    hasAuth: false,
    scheme: "redis",
  },
  {
    id: "mongodb",
    label: "MongoDB",
    versions: ["8.0", "7.0", "6.0"],
    defaultPort: 27017,
    hasDatabase: true,
    hasAuth: true,
    scheme: "mongodb",
  },
  {
    id: "clickhouse",
    label: "ClickHouse",
    versions: ["24.12", "24.8", "23.8"],
    defaultPort: 8123,
    hasDatabase: true,
    hasAuth: true,
    scheme: "clickhouse",
  },
  {
    id: "pocketbase",
    label: "PocketBase",
    versions: ["0.24", "0.23", "0.22"],
    defaultPort: 8090,
    hasDatabase: false,
    hasAuth: false,
    scheme: "http",
    isHttpService: true,
    requiresSuperuser: true,
  },
];

function getServiceOption(id: ServiceType): ServiceOption {
  return SERVICE_OPTIONS.find((s) => s.id === id) ?? SERVICE_OPTIONS[0];
}

function buildConnectionString(
  service: ServiceOption,
  state: WizardState,
  port: string
): string {
  if (service.isHttpService) {
    return `http://127.0.0.1:${port}`;
  }
  if (!service.hasAuth) {
    // Redis: password-only auth, no user, no db name in URL
    return `${service.scheme}://:${state.password}@127.0.0.1:${port}/0`;
  }
  const dbPart = service.hasDatabase ? `/${state.dbName}` : "";
  return `${service.scheme}://${state.username}:${state.password}@127.0.0.1:${port}${dbPart}`;
}

const DEFAULT_STATE: WizardState = {
  serviceType: "postgres",
  environment: "development",
  name: "",
  version: "17",
  port: "5432",
  dbName: "",
  username: "",
  password: "",
};

const STEPS = ["Service", "Environment", "Configure", "Review"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────

function generatePassword(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => chars[b % chars.length])
    .join("");
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ── Step components ───────────────────────────────────────────────────────

function StepService({
  value,
  onChange,
}: {
  value: ServiceType;
  onChange: (v: ServiceType) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Choose the database engine to provision.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {SERVICE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={cn(
              "flex flex-col items-start rounded-xl border px-4 py-4 text-left transition-colors",
              value === opt.id
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground"
            )}
          >
            <div className="flex w-full items-center justify-between">
              <Database className="h-5 w-5 text-muted-foreground" />
              {value === opt.id && (
                <Check className="h-4 w-4 text-primary" />
              )}
            </div>
            <span className="mt-3 text-sm font-medium text-foreground">
              {opt.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {opt.versions.length} versions
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const ENV_OPTIONS: { id: Environment; label: string; desc: string }[] = [
  { id: "development", label: "Development", desc: "Local dev work" },
  { id: "testing", label: "Testing", desc: "CI, automated tests" },
  { id: "staging", label: "Staging", desc: "Pre-production review" },
  { id: "production", label: "Production", desc: "Live traffic" },
];

function StepEnvironment({
  value,
  onChange,
}: {
  value: Environment;
  onChange: (v: Environment) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Choose the target environment for this instance.
      </p>
      <div className="space-y-2">
        {ENV_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={cn(
              "flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors",
              value === opt.id
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground"
            )}
          >
            <div>
              <p className="text-sm font-medium text-foreground">{opt.label}</p>
              <p className="text-xs text-muted-foreground">{opt.desc}</p>
            </div>
            {value === opt.id && <Check className="h-4 w-4 text-primary" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  id,
  children,
  hint,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Input({
  id,
  value,
  onChange,
  placeholder,
  type = "text",
  className,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none",
        className
      )}
    />
  );
}

function StepConfigure({
  state,
  onChange,
}: {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  const [showPw, setShowPw] = useState(false);
  const service = getServiceOption(state.serviceType);

  return (
    <div className="space-y-4">
      <Field
        label="Instance name"
        id="name"
        hint="Used to label the container and volume."
      >
        <Input
          id="name"
          value={state.name}
          onChange={(v) => {
            const slug = slugify(v);
            onChange({
              name: v,
              // Only auto-fill dbName / username for SQL services
              ...(service.hasDatabase ? { dbName: slug || state.dbName } : {}),
              ...(service.hasAuth ? { username: slug ? `${slug}_user` : state.username } : {}),
            });
          }}
          placeholder="e.g. inventory-dev"
        />
      </Field>

      <Field label="Version" id="version">
        <div className="inline-flex flex-wrap gap-1.5 rounded-lg border border-border bg-muted/40 p-1">
          {service.versions.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange({ version: v })}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                state.version === v
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Host port"
        id="port"
        hint={`The local port to bind on 127.0.0.1. Default for ${service.label}: ${service.defaultPort}.`}
      >
        <Input
          id="port"
          value={state.port}
          onChange={(v) => onChange({ port: v })}
          placeholder={String(service.defaultPort)}
        />
      </Field>

      {service.hasDatabase && (
        <Field label="Database name" id="dbName">
          <Input
            id="dbName"
            value={state.dbName}
            onChange={(v) => onChange({ dbName: v })}
            placeholder="my_database"
          />
        </Field>
      )}

      {service.hasAuth && (
        <Field label="Username" id="username">
          <Input
            id="username"
            value={state.username}
            onChange={(v) => onChange({ username: v })}
            placeholder="db_user"
          />
        </Field>
      )}

      {service.requiresSuperuser ? (
        <>
          <Field
            label="Admin email"
            id="username"
            hint="This becomes the PocketBase superuser login. Created automatically on first start."
          >
            <Input
              id="username"
              type="email"
              value={state.username}
              onChange={(v) => onChange({ username: v })}
              placeholder="admin@example.com"
            />
          </Field>
          <Field
            label="Admin password"
            id="password"
            hint="Minimum 10 characters (PocketBase requirement)."
          >
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="password"
                  type={showPw ? "text" : "password"}
                  value={state.password}
                  onChange={(v) => onChange({ password: v })}
                  placeholder="••••••••••••"
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPw ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <button
                type="button"
                onClick={() => onChange({ password: generatePassword() })}
                title="Generate password"
                className="flex items-center justify-center rounded-lg border border-border px-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </Field>
        </>
      ) : service.isHttpService ? null : (
        <Field label="Password" id="password">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="password"
              type={showPw ? "text" : "password"}
              value={state.password}
              onChange={(v) => onChange({ password: v })}
              placeholder="••••••••••••"
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPw ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={() => onChange({ password: generatePassword() })}
            title="Generate password"
            className="flex items-center justify-center rounded-lg border border-border px-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </Field>
      )}
    </div>
  );
}

function ConnectionStringRow({ connStr }: { connStr: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group flex items-center gap-2 rounded-lg border border-border bg-muted/60 px-3 py-2">
      <code className="flex-1 truncate font-mono text-xs text-foreground">
        {connStr}
      </code>
      <button
        onClick={() => {
          copyText(connStr);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function StepReview({ state }: { state: WizardState }) {
  const service = getServiceOption(state.serviceType);
  const port = state.port || String(service.defaultPort);
  const connStr = buildConnectionString(service, state, port);
  const slug = slugify(state.name);

  const rows: [string, string][] = [
    ["Service", `${service.label} ${state.version}`],
    ["Environment", state.environment],
    ["Container", `sdm_${slug}_${service.id}`],
    ["Volume", `sdm_${slug}_${service.id}_data`],
    ["Host port", `127.0.0.1:${port}`],
  ];
  if (service.hasDatabase) rows.push(["Database", state.dbName]);
  if (service.hasAuth) rows.push(["Username", state.username]);
  if (service.requiresSuperuser) rows.push(["Admin email", state.username]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Review the configuration before creating. The database will be bound to
        localhost only.
      </p>
      <div className="divide-y divide-border rounded-xl border border-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-xs text-muted-foreground">{k}</span>
            <span className="font-mono text-xs text-foreground">{v}</span>
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Connection string</p>
        <ConnectionStringRow connStr={connStr} />
      </div>
      {service.requiresSuperuser ? (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
          <p className="text-xs text-emerald-700 dark:text-emerald-300">
            The superuser <strong>{state.username}</strong> will be created
            automatically inside the container on first start. Save your
            password — it won’t be shown again.
          </p>
        </div>
      ) : service.isHttpService ? null : (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Save your password now — it won't be shown in full again.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Validation ────────────────────────────────────────────────────────────

function validateStep(step: number, state: WizardState): string | null {
  if (step === 2) {
    const service = getServiceOption(state.serviceType);
    if (!state.name.trim()) return "Instance name is required.";
    if (service.hasDatabase && !state.dbName.trim())
      return "Database name is required.";
    if (service.hasAuth && !state.username.trim())
      return "Username is required.";
    if (service.requiresSuperuser) {
      if (!state.username.trim()) return "Admin email is required.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(state.username))
        return "Admin email must be a valid email address.";
      if (!state.password.trim()) return "Password is required.";
      if (state.password.length < 10)
        return "PocketBase admin password must be at least 10 characters.";
    } else if (!service.isHttpService) {
      if (!state.password.trim()) return "Password is required.";
      if (state.password.length < 8)
        return "Password must be at least 8 characters.";
    }
    const port = parseInt(state.port, 10);
    if (isNaN(port) || port < 1024 || port > 65535)
      return "Port must be between 1024 and 65535.";
  }
  return null;
}

// ── Main wizard ───────────────────────────────────────────────────────────

export function CreateInstanceWizard({
  onClose,
  projectId = "default",
}: {
  onClose: () => void;
  projectId?: string;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>({
    ...DEFAULT_STATE,
    password: generatePassword(),
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function patch(partial: Partial<WizardState>) {
    setState((s) => {
      const next = { ...s, ...partial };
      // When the service type changes, snap version + port to that service's defaults
      if (partial.serviceType && partial.serviceType !== s.serviceType) {
        const opt = getServiceOption(partial.serviceType);
        next.version = opt.versions[0];
        next.port = String(opt.defaultPort);
        // Clear username so PocketBase doesn't inherit a slugged DB username
        if (opt.requiresSuperuser) {
          next.username = "";
        }
      }
      return next;
    });
    setError(null);
  }

  async function handleNext() {
    const err = validateStep(step, state);
    if (err) {
      setError(err);
      return;
    }
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
      setError(null);
    } else {
      await handleCreate();
    }
  }

  async function handleCreate() {
    setSubmitting(true);
    setError(null);
    try {
      const service = getServiceOption(state.serviceType);
      const input: CreateInstanceInput = {
        service_type: state.serviceType,
        name: state.name,
        version: state.version,
        port: parseInt(state.port, 10),
        db_name: service.hasDatabase ? state.dbName : null,
        username: service.hasAuth || service.requiresSuperuser ? state.username : null,
        password: service.isHttpService && !service.requiresSuperuser ? "" : state.password,
        environment: state.environment,
        project_id: projectId,
      };
      await createLocalInstance(input);
      await queryClient.invalidateQueries({ queryKey: ["local-instances"] });
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : "Failed to create instance.");
    } finally {
      setSubmitting(false);
    }
  }

  const isLastStep = step === STEPS.length - 1;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Panel */}
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              New Database Instance
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Step {step + 1} of {STEPS.length} — {STEPS[step]}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex gap-1 px-6 pt-4">
          {STEPS.map((label, i) => (
            <div key={label} className="flex flex-1 flex-col gap-1">
              <div
                className={cn(
                  "h-1 rounded-full transition-colors",
                  i <= step ? "bg-primary" : "bg-muted"
                )}
              />
              <span
                className={cn(
                  "text-[10px]",
                  i === step
                    ? "font-medium text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {step === 0 && (
            <StepService
              value={state.serviceType}
              onChange={(v) => patch({ serviceType: v })}
            />
          )}
          {step === 1 && (
            <StepEnvironment
              value={state.environment}
              onChange={(v) => patch({ environment: v })}
            />
          )}
          {step === 2 && <StepConfigure state={state} onChange={patch} />}
          {step === 3 && <StepReview state={state} />}

          {error && (
            <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-6 py-4">
          <button
            onClick={() => {
              if (step === 0) onClose();
              else setStep((s) => s - 1);
            }}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {step === 0 ? "Cancel" : "Back"}
          </button>

          <button
            onClick={handleNext}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Creating…
              </>
            ) : isLastStep ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Create Instance
              </>
            ) : (
              <>
                Next
                <ChevronRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
