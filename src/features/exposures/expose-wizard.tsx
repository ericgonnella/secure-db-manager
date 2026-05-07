import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Globe,
  Cloud,
  Zap,
  Lock,
  AlertTriangle,
  Info,
  ArrowRight,
  CheckCircle,
  Download,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createExposure,
  previewExposure,
  checkToolAvailable,
  downloadAndInstallTool,
  addFirewallRule,
  type Exposure,
  type ExposureMethod,
  type ExposurePreview,
  type LocalInstance,
} from "@/lib/tauri";

interface Props {
  instance: LocalInstance;
  onClose: () => void;
}

const METHODS: {
  id: ExposureMethod;
  label: string;
  tagline: string;
  description: string;
  Icon: typeof Globe;
  recommendedFor: string;
}[] = [
  {
    id: "direct",
    label: "Direct connection",
    tagline: "Simplest, no third-party",
    description:
      "Open the port on your machine so anyone with the address can connect. Great for trusted networks or testing.",
    Icon: Globe,
    recommendedFor: "Lowest latency. Requires you control the firewall / router.",
  },
  {
    id: "cloudflare",
    label: "Cloudflare Tunnel",
    tagline: "Public HTTPS URL via Cloudflare",
    description:
      "A Cloudflare quick tunnel exposes your service to the internet over a temporary trycloudflare.com URL. Best for HTTP-based services.",
    Icon: Cloud,
    recommendedFor: "PocketBase, ClickHouse, or anything with a web UI.",
  },
  {
    id: "ngrok",
    label: "ngrok",
    tagline: "Public TCP tunnel",
    description:
      "Use ngrok to assign a public TCP host:port that forwards to your local database. Works for raw database protocols.",
    Icon: Zap,
    recommendedFor: "PostgreSQL, MySQL, MongoDB, Redis. Requires an ngrok account.",
  },
  {
    id: "nginx",
    label: "TLS reverse proxy",
    tagline: "nginx with self-signed TLS",
    description:
      "Run an nginx proxy in front of your database with TLS termination. Adds encryption without exposing the raw protocol.",
    Icon: Lock,
    recommendedFor: "Any service. Adds encryption layer; works for both HTTP and raw TCP protocols.",
  },
];

export function ExposeWizard({ instance, onClose }: Props) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"method" | "config" | "preview" | "firewall">("method");
  const [method, setMethod] = useState<ExposureMethod | null>(null);
  // Default direct/nginx port to instance.port + 10000 to avoid host conflict
  const [externalPort, setExternalPort] = useState(
    String(Math.min(instance.port + 10000, 65535))
  );
  const [ngrokToken, setNgrokToken] = useState("");
  const [preview, setPreview] = useState<ExposurePreview | null>(null);
  const [createdExposure, setCreatedExposure] = useState<Exposure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [firewallResult, setFirewallResult] = useState<string | null>(null);

  const selectedMethod = useMemo(
    () => METHODS.find((m) => m.id === method),
    [method]
  );

  // Check if the required tool is installed for cloudflare / ngrok
  const toolName =
    method === "cloudflare" ? "cloudflared" : method === "ngrok" ? "ngrok" : null;
  const toolQuery = useQuery({
    queryKey: ["tool-available", toolName],
    queryFn: () => checkToolAvailable(toolName!),
    enabled: !!toolName && step === "config",
    staleTime: 5_000,
  });
  const toolAvailable = !toolName || toolQuery.data?.available === true;

  const installMutation = useMutation({
    mutationFn: () => downloadAndInstallTool(toolName!),
    onSuccess: () => {
      // Invalidate so toolQuery re-runs
      queryClient.invalidateQueries({ queryKey: ["tool-available", toolName] });
    },
    onError: (err) => setError(String(err)),
  });

  const firewallMutation = useMutation({
    mutationFn: () => {
      const port =
        (method === "direct" || method === "nginx")
          ? Number(externalPort)
          : createdExposure?.external_port ?? 0;
      const ruleName = `SDM ${instance.name} port ${port}`;
      return addFirewallRule(port, ruleName, createdExposure?.id);
    },
    onSuccess: (result) => {
      setFirewallResult(
        result.success
          ? result.message
          : `${result.message}${
              result.manual_command
                ? `\n\nRun manually (as admin):\n${result.manual_command}`
                : ""
            }`
      );
    },
    onError: (err) => setFirewallResult(`Error: ${String(err)}`),
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      previewExposure({
        instance_id: instance.id,
        method: method!,
        external_port: method === "direct" || method === "nginx"
          ? Number(externalPort) || null
          : null,
        ngrok_token: method === "ngrok" && ngrokToken ? ngrokToken : null,
      }),
    onSuccess: (data) => {
      setPreview(data);
      setStep("preview");
    },
    onError: (err) => setError(String(err)),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createExposure({
        instance_id: instance.id,
        method: method!,
        external_port: method === "direct" || method === "nginx"
          ? Number(externalPort) || null
          : null,
        ngrok_token: method === "ngrok" && ngrokToken ? ngrokToken : null,
      }),
    onSuccess: (exposure: Exposure) => {
      queryClient.invalidateQueries({ queryKey: ["exposures"] });
      setCreatedExposure(exposure);
      // Offer firewall config for direct/nginx exposures
      if (method === "direct" || method === "nginx") {
        setStep("firewall");
      } else {
        onClose();
        const target = exposure.external_endpoint ?? "(no endpoint reported)";
        alert(`Exposure live at: ${target}`);
      }
    },
    onError: (err) => setError(String(err)),
  });

  useEffect(() => {
    setError(null);
  }, [step]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              Expose &ldquo;{instance.name}&rdquo; publicly
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pick a method, review the steps, and we&apos;ll set it up for you.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 border-b border-border px-5 py-3 text-[11px] uppercase tracking-wide text-muted-foreground">
          <StepDot active={step === "method"} done={step !== "method"} label="Method" />
          <ArrowRight className="h-3 w-3" />
          <StepDot active={step === "config"} done={step === "preview" || step === "firewall"} label="Config" />
          <ArrowRight className="h-3 w-3" />
          <StepDot active={step === "preview"} done={step === "firewall"} label="Review" />
          {(method === "direct" || method === "nginx") && (
            <>
              <ArrowRight className="h-3 w-3" />
              <StepDot active={step === "firewall"} done={false} label="Firewall" />
            </>
          )}
        </div>

        <div className="space-y-4 px-5 py-5">
          {step === "method" && (
            <div className="grid gap-2">
              {METHODS.map((m) => {
                const isSelected = method === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setMethod(m.id)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                      isSelected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40 hover:bg-muted/50"
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                        isSelected
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      <m.Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {m.label}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {m.tagline}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {m.description}
                      </p>
                      <p className="mt-1 text-[11px] italic text-muted-foreground">
                        {m.recommendedFor}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {step === "config" && selectedMethod && (
            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{selectedMethod.label}.</span>{" "}
                {selectedMethod.description}
              </div>

              {(method === "direct" || method === "nginx") && (
                <Field label="External port">
                  <input
                    value={externalPort}
                    onChange={(e) =>
                      setExternalPort(e.target.value.replace(/[^\d]/g, ""))
                    }
                    placeholder={String(instance.port)}
                    className={inputCls}
                    inputMode="numeric"
                  />
                </Field>
              )}

              {method === "ngrok" && (
                <Field label="ngrok auth token">
                  <input
                    value={ngrokToken}
                    onChange={(e) => setNgrokToken(e.target.value)}
                    placeholder="2abc... (find this in your ngrok dashboard)"
                    className={inputCls}
                    type="password"
                  />
                  <span className="mt-1 text-[11px] text-muted-foreground">
                    Stored in your OS keychain. Leave blank to reuse a previously-saved token.
                  </span>
                </Field>
              )}

              {method === "cloudflare" && (
                <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  No configuration needed — Cloudflare will assign a random{" "}
                  <code className="rounded bg-background px-1 py-0.5 font-mono">
                    trycloudflare.com
                  </code>{" "}
                  URL when the tunnel starts.
                </div>
              )}

              {/* Tool availability banner for cloudflare / ngrok */}
              {toolName && (
                <div
                  className={cn(
                    "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs",
                    toolAvailable
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                      : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                  )}
                >
                  {toolAvailable ? (
                    <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  <div className="flex-1">
                    {toolAvailable ? (
                      <span><strong>{toolName}</strong> is installed and ready.</span>
                    ) : (
                      <>
                        <span>
                          <strong>{toolName}</strong> is not installed.{" "}
                          {toolName === "cloudflared"
                            ? "Click Install to download it automatically."
                            : "Download and install it from ngrok.com/download, then return here."}
                        </span>
                        <div className="mt-2 flex items-center gap-2">
                          {toolName === "cloudflared" ? (
                            <button
                              onClick={() => installMutation.mutate()}
                              disabled={installMutation.isPending}
                              className="flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-600 disabled:opacity-60"
                            >
                              <Download className="h-3 w-3" />
                              {installMutation.isPending ? "Downloading…" : "Install cloudflared"}
                            </button>
                          ) : (
                            <a
                              href={toolQuery.data?.download_url ?? "https://ngrok.com/download"}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-600"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Open ngrok.com/download
                            </a>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "preview" && preview && (
            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Here&apos;s exactly what we&apos;ll do when you confirm. Nothing has been
                changed yet.
              </div>

              <ol className="space-y-2">
                {preview.steps.map((s) => (
                  <li
                    key={s.step}
                    className="flex gap-3 rounded-md border border-border bg-card p-3"
                  >
                    <div
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                        s.kind === "warning"
                          ? "bg-amber-500/15 text-amber-500"
                          : s.kind === "action"
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {s.step}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">
                        {s.title}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {s.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>

              {preview.expected_endpoint && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    Expected endpoint:
                  </span>{" "}
                  <code className="font-mono text-foreground">
                    {preview.expected_endpoint}
                  </code>
                </div>
              )}

              {preview.warnings.length > 0 && (
                <div className="space-y-1.5">
                  {preview.warnings.map((w, i) => (
                    <div
                      key={i}
                      className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                    >
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === "firewall" && createdExposure && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-xs">
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <div>
                  <div className="font-medium text-emerald-700 dark:text-emerald-400">
                    Exposure is live!
                  </div>
                  {createdExposure.external_endpoint && (
                    <code className="mt-0.5 block font-mono text-foreground">
                      {createdExposure.external_endpoint}
                    </code>
                  )}
                </div>
              </div>

              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <div className="mb-2 flex items-center gap-1.5 font-medium text-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Configure firewall (optional)
                </div>
                <p>
                  To make port{" "}
                  <strong>{createdExposure.external_port}</strong> reachable from outside
                  this machine, we can attempt to add an inbound firewall rule automatically.
                  This may require administrator privileges.
                </p>
              </div>

              {firewallResult && (
                <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-[11px] text-foreground">
                  {firewallResult}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3" />
            <span>You&apos;ll be asked to confirm before anything runs.</span>
          </div>
          <div className="flex items-center gap-2">
            {step !== "method" && step !== "firewall" && (
              <button
                onClick={() =>
                  setStep(step === "preview" ? "config" : "method")
                }
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Back
              </button>
            )}
            {step === "method" && (
              <button
                onClick={() => method && setStep("config")}
                disabled={!method}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Continue
              </button>
            )}
            {step === "config" && (
              <button
                onClick={() => previewMutation.mutate()}
                disabled={previewMutation.isPending || (!!toolName && !toolAvailable)}
                title={toolName && !toolAvailable ? `Install ${toolName} first` : undefined}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {previewMutation.isPending ? "Loading…" : "Preview steps"}
              </button>
            )}
            {step === "preview" && (
              <button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {createMutation.isPending ? "Setting up…" : "Confirm & run"}
              </button>
            )}
            {step === "firewall" && (
              <>
                {!firewallResult && (
                  <button
                    onClick={() => firewallMutation.mutate()}
                    disabled={firewallMutation.isPending}
                    className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {firewallMutation.isPending ? "Configuring…" : "Configure firewall"}
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80"
                >
                  {firewallResult ? "Done" : "Skip"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function StepDot({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1",
        active
          ? "bg-primary/10 text-primary"
          : done
          ? "text-foreground"
          : "text-muted-foreground"
      )}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
