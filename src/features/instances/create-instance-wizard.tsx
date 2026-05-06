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
import { createLocalPostgres, type CreatePostgresInput } from "@/lib/tauri";

// ── Types ─────────────────────────────────────────────────────────────────

type ServiceType = "postgres" | "pocketbase" | "redis" | "mysql";
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

const DEFAULT_STATE: WizardState = {
  serviceType: "postgres",
  environment: "development",
  name: "",
  version: "17",
  port: "5435",
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

const SERVICE_OPTIONS: {
  id: ServiceType;
  label: string;
  version: string;
  disabled?: boolean;
}[] = [
  { id: "postgres", label: "PostgreSQL", version: "17" },
  { id: "pocketbase", label: "PocketBase", version: "latest", disabled: true },
  { id: "redis", label: "Redis", version: "7", disabled: true },
  { id: "mysql", label: "MySQL", version: "8", disabled: true },
];

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
            disabled={opt.disabled}
            onClick={() => onChange(opt.id)}
            className={cn(
              "flex flex-col items-start rounded-xl border px-4 py-4 text-left transition-colors",
              opt.disabled && "cursor-not-allowed opacity-40",
              !opt.disabled &&
                value === opt.id &&
                "border-primary bg-primary/5",
              !opt.disabled &&
                value !== opt.id &&
                "border-border hover:border-muted-foreground"
            )}
          >
            <div className="flex w-full items-center justify-between">
              <Database className="h-5 w-5 text-muted-foreground" />
              {!opt.disabled && value === opt.id && (
                <Check className="h-4 w-4 text-primary" />
              )}
              {opt.disabled && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  soon
                </span>
              )}
            </div>
            <span className="mt-3 text-sm font-medium text-foreground">
              {opt.label}
            </span>
            <span className="text-xs text-muted-foreground">v{opt.version}</span>
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
              dbName: slug || state.dbName,
              username: slug ? `${slug}_user` : state.username,
            });
          }}
          placeholder="e.g. inventory-dev"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Version" id="version">
          <Input
            id="version"
            value={state.version}
            onChange={(v) => onChange({ version: v })}
            placeholder="17"
          />
        </Field>
        <Field
          label="Host port"
          id="port"
          hint="The local port to bind on 127.0.0.1."
        >
          <Input
            id="port"
            value={state.port}
            onChange={(v) => onChange({ port: v })}
            placeholder="5435"
          />
        </Field>
      </div>

      <Field label="Database name" id="dbName">
        <Input
          id="dbName"
          value={state.dbName}
          onChange={(v) => onChange({ dbName: v })}
          placeholder="my_database"
        />
      </Field>

      <Field label="Username" id="username">
        <Input
          id="username"
          value={state.username}
          onChange={(v) => onChange({ username: v })}
          placeholder="db_user"
        />
      </Field>

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
  const port = state.port || "5435";
  const connStr = `postgresql://${state.username}:${state.password}@127.0.0.1:${port}/${state.dbName}`;

  const rows: [string, string][] = [
    ["Service", "PostgreSQL " + state.version],
    ["Environment", state.environment],
    ["Container", `sdm_${slugify(state.name)}_postgres`],
    ["Volume", `sdm_${slugify(state.name)}_pgdata`],
    ["Host port", `127.0.0.1:${port}`],
    ["Database", state.dbName],
    ["Username", state.username],
  ];

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
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Save your password now — it won't be shown in full again.
        </p>
      </div>
    </div>
  );
}

// ── Validation ────────────────────────────────────────────────────────────

function validateStep(step: number, state: WizardState): string | null {
  if (step === 2) {
    if (!state.name.trim()) return "Instance name is required.";
    if (!state.dbName.trim()) return "Database name is required.";
    if (!state.username.trim()) return "Username is required.";
    if (!state.password.trim()) return "Password is required.";
    if (state.password.length < 8)
      return "Password must be at least 8 characters.";
    const port = parseInt(state.port, 10);
    if (isNaN(port) || port < 1024 || port > 65535)
      return "Port must be between 1024 and 65535.";
  }
  return null;
}

// ── Main wizard ───────────────────────────────────────────────────────────

export function CreateInstanceWizard({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>({
    ...DEFAULT_STATE,
    password: generatePassword(),
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function patch(partial: Partial<WizardState>) {
    setState((s) => ({ ...s, ...partial }));
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
      const input: CreatePostgresInput = {
        name: state.name,
        version: state.version,
        port: parseInt(state.port, 10),
        db_name: state.dbName,
        username: state.username,
        password: state.password,
        environment: state.environment,
      };
      await createLocalPostgres(input);
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
