import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  X,
  Globe,
  Cloud,
  Zap,
  Lock,
  Link,
  AlertTriangle,
  Info,
  ArrowRight,
  CheckCircle,
  Download,
  ExternalLink,
  ShieldCheck,
  Copy,
  Check,
  Router,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createExposure,
  previewExposure,
  checkToolAvailable,
  downloadAndInstallTool,
  addFirewallRule,
  getPublicIp,
  listExposures,
  removeExposure,
  type Exposure,
  type ExposureMethod,
  type ExposurePreview,
  type LocalInstance,
  type WebApp,
} from "@/lib/tauri";

interface Props {
  /** Provide either an instance or a web app as the exposure target. */
  instance?: LocalInstance;
  webApp?: WebApp;
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
  {
    id: "localtunnel",
    label: "localtunnel",
    tagline: "Free HTTPS tunnel, no account needed",
    description:
      "Use localtunnel.me to get an instant public HTTPS URL for your service — completely free, no sign-up or auth token required.",
    Icon: Link,
    recommendedFor: "Web apps, PocketBase, ClickHouse. HTTP/HTTPS only — not suitable for raw TCP database protocols (Postgres, MySQL).",
  },
];

export function ExposeWizard({ instance, webApp, onClose }: Props) {
  // Derive a unified "target" view so the rest of the component is target-agnostic.
  const targetId = instance?.id ?? webApp?.id ?? "";
  const targetName = instance?.name ?? webApp?.name ?? "";
  const targetPort = instance?.port ?? webApp?.port ?? 0;
  const targetType: "instance" | "web_app" = webApp ? "web_app" : "instance";

  // Instances: all methods except localtunnel (HTTP-only, not useful for raw TCP DBs).
  // Web apps: all methods (HTTP-based, localtunnel makes sense).
  const availableMethods = useMemo(
    () =>
      targetType === "web_app"
        ? METHODS
        : METHODS.filter((m) => m.id !== "localtunnel"),
    [targetType]
  );

  // ── Smart recommendation ────────────────────────────────────────────────
  // For instances: raw-TCP databases → ngrok; HTTP-native (PocketBase, ClickHouse) → cloudflare; fallback → direct.
  // For web apps:  dev mode → localtunnel (instant, free); deploy mode → cloudflare (stable HTTPS).
  const recommendedMethodId = useMemo((): ExposureMethod | null => {
    if (targetType === "web_app" && webApp) {
      return webApp.mode === "dev" ? "localtunnel" : "cloudflare";
    }
    if (instance) {
      const rawTcp = ["postgres", "mysql", "mariadb", "mongodb", "redis"];
      const httpBased = ["clickhouse", "pocketbase"];
      if (rawTcp.includes(instance.service_type)) return "ngrok";
      if (httpBased.includes(instance.service_type)) return "cloudflare";
    }
    return "direct";
  }, [targetType, instance, webApp]);

  // Auto-select the recommended method when the wizard first opens.
  useEffect(() => {
    if (method === null && recommendedMethodId) {
      setMethod(recommendedMethodId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedMethodId]);

  const queryClient = useQueryClient();
  const [step, setStep] = useState<"method" | "config" | "preview" | "firewall">("method");
  const [method, setMethod] = useState<ExposureMethod | null>(null);
  // Default direct/nginx port to targetPort + 10000 to avoid host conflict
  const [externalPort, setExternalPort] = useState(
    String(Math.min(targetPort + 10000, 65535))
  );
  const [ngrokToken, setNgrokToken] = useState("");
  const [ltSubdomain, setLtSubdomain] = useState("");
  const [preview, setPreview] = useState<ExposurePreview | null>(null);
  const [createdExposure, setCreatedExposure] = useState<Exposure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [firewallResult, setFirewallResult] = useState<string | null>(null);
  const [publicIp, setPublicIp] = useState<string | null>(null);

  // Fetch public IP as soon as we reach the firewall step
  useEffect(() => {
    if (step === "firewall") {
      getPublicIp().then((ip) => setPublicIp(ip ?? null)).catch(() => {});
    }
  }, [step]);

  // Download progress tracking (cloudflared installer)
  const [downloadPhase, setDownloadPhase] = useState<"idle" | "downloading" | "complete" | "error">("idle");
  const [downloadMessage, setDownloadMessage] = useState("");
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Custom URL dialog (replaces alert())
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);

  useEffect(() => {
    // Subscribe to download progress events from the Rust backend.
    let active = true;
    listen<{ tool: string; downloaded: number; phase: string; message: string }>(
      "tool-download-progress",
      (event) => {
        if (!active) return;
        const { downloaded, phase, message } = event.payload;
        setDownloadedBytes(downloaded);
        setDownloadMessage(message);
        if (phase === "downloading") setDownloadPhase("downloading");
        else if (phase === "complete") setDownloadPhase("complete");
        else if (phase === "error") setDownloadPhase("error");
      },
    ).then((unlisten) => {
      if (active) unlistenRef.current = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      unlistenRef.current?.();
    };
  }, []);

  const selectedMethod = useMemo(
    () => METHODS.find((m) => m.id === method),
    [method]
  );

  // Check if the required tool is installed for cloudflare / ngrok
  const toolName =
    method === "cloudflare" ? "cloudflared" :
    method === "ngrok" ? "ngrok" :
    method === "localtunnel" ? "lt" :
    null;
  const toolQuery = useQuery({
    queryKey: ["tool-available", toolName],
    queryFn: () => checkToolAvailable(toolName!),
    enabled: !!toolName && step === "config",
    staleTime: 5_000,
  });
  const toolAvailable = !toolName || toolQuery.data?.available === true;

  const installMutation = useMutation({
    mutationFn: () => downloadAndInstallTool(toolName!),
    onMutate: () => {
      setDownloadPhase("downloading");
      setDownloadMessage("Starting downloadâ€¦");
      setDownloadedBytes(0);
    },
    onSuccess: () => {
      // Invalidate so toolQuery re-runs
      queryClient.invalidateQueries({ queryKey: ["tool-available", toolName] });
    },
    onError: (err) => {
      setDownloadPhase("error");
      setError(String(err));
    },
  });

  // ── Duplicate-exposure guard ─────────────────────────────────────────────
  // Each target (instance or web app) can have at most one active exposure at
  // a time. Multiple tunnels to the same target double the attack surface for
  // no benefit.
  const { data: allExposures = [] } = useQuery({
    queryKey: ["exposures"],
    queryFn: listExposures,
  });
  const existingExposure = allExposures.find(
    (e) => e.instance_id === targetId && e.status === "active"
  );

  const removeExistingMutation = useMutation({
    mutationFn: (id: string) => removeExposure(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exposures"] });
    },
    onError: (err) => setError(String(err)),
  });

  const firewallMutation = useMutation({
    mutationFn: () => {
      const port =
        (method === "direct" || method === "nginx")
          ? Number(externalPort)
          : createdExposure?.external_port ?? 0;
      const ruleName = `Baseport ${targetName} port ${port}`;
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
        instance_id: targetId,
        method: method!,
        external_port: method === "direct" || method === "nginx"
          ? Number(externalPort) || null
          : null,
        ngrok_token: method === "ngrok" && ngrokToken ? ngrokToken : null,
        lt_subdomain: method === "localtunnel" && ltSubdomain ? ltSubdomain : null,
        target_type: targetType,
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
        instance_id: targetId,
        method: method!,
        external_port: method === "direct" || method === "nginx"
          ? Number(externalPort) || null
          : null,
        ngrok_token: method === "ngrok" && ngrokToken ? ngrokToken : null,
        lt_subdomain: method === "localtunnel" && ltSubdomain ? ltSubdomain : null,
        target_type: targetType,
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
        setLiveUrl(target);
      }
    },
    onError: (err) => setError(String(err)),
  });

  useEffect(() => {
    setError(null);
  }, [step]);

  // â”€â”€ Live URL dialog (replaces native alert) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (liveUrl) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500" />
              <h2 className="text-sm font-semibold text-foreground">
                Exposure is live
              </h2>
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-4 px-5 py-5">
            <p className="text-xs text-muted-foreground">
              Your database is now publicly accessible at the URL below. You
              can select and copy the text directly.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
              <code
                className="min-w-0 flex-1 break-all font-mono text-xs text-foreground"
                style={{ userSelect: "text" }}
              >
                {liveUrl}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(liveUrl).catch(() => {});
                  setUrlCopied(true);
                  setTimeout(() => setUrlCopied(false), 1500);
                }}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Copy URL"
              >
                {urlCopied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
              {liveUrl.startsWith("http") && (
                <a
                  href={liveUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Open in browser"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {method === "cloudflare"
                ? "The Cloudflare URL is temporary and changes on every restart."
                : method === "localtunnel"
                ? "The localtunnel URL is temporary and changes on every restart."
                : "The tunnel URL is temporary and will change if the tunnel is restarted."}{" "}
              Check the Exposures tab to see the current URL at any time.
            </p>
          </div>
          <div className="flex justify-end border-t border-border px-5 py-3">
            <button
              onClick={onClose}
              className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              Expose &ldquo;{targetName}&rdquo; publicly
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
          {step === "method" && existingExposure && (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="flex-1 space-y-2">
                  <div className="font-medium text-amber-600 dark:text-amber-400">
                    Already exposed via {existingExposure.method}
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    Each {targetType === "web_app" ? "web app" : "instance"} can have at most one active
                    exposure at a time. Remove the existing exposure to create a new one.
                  </p>
                  {existingExposure.external_endpoint && (
                    <div className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1.5">
                      <code className="flex-1 truncate font-mono text-[11px] text-foreground">
                        {existingExposure.external_endpoint}
                      </code>
                    </div>
                  )}
                  <button
                    onClick={() => removeExistingMutation.mutate(existingExposure.id)}
                    disabled={removeExistingMutation.isPending}
                    className="rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-600 disabled:opacity-60"
                  >
                    {removeExistingMutation.isPending ? "Removing…" : "Remove existing exposure"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "method" && !existingExposure && (
            <div className="grid gap-2">
              {availableMethods.map((m) => {
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
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-foreground">
                            {m.label}
                          </span>
                          {m.id === recommendedMethodId && (
                            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500">
                              Recommended
                            </span>
                          )}
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
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
                    placeholder={String(targetPort)}
                    className={inputCls}
                    inputMode="numeric"
                  />
                </Field>
              )}

              {method === "ngrok" && (
                <>
                  <div className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <div className="flex-1 space-y-1.5">
                      <div className="font-medium text-amber-600 dark:text-amber-400">
                        Billing setup required (even for the free plan)
                      </div>
                      <p className="text-muted-foreground leading-relaxed">
                        ngrok TCP tunnels require a verified account. Even if you stay on the free
                        tier, you must add a payment method on your ngrok dashboard before TCP
                        tunnels will connect — otherwise the tunnel will start but produce no
                        public endpoint.
                      </p>
                      <a
                        href="https://dashboard.ngrok.com/billing"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-amber-700 underline hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
                      >
                        Open ngrok billing
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
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
                </>
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

              {method === "localtunnel" && (
                <>
                  <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                    <div className="mb-1 font-medium text-foreground">No account required</div>
                    localtunnel.me is completely free — no sign-up, no tokens. You get an instant
                    public HTTPS URL. Works for HTTP-based services (web apps, PocketBase, ClickHouse).
                    Not suitable for raw TCP database protocols.
                  </div>
                  <Field label="Custom subdomain (optional)">
                    <input
                      value={ltSubdomain}
                      onChange={(e) =>
                        setLtSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                      }
                      placeholder="my-app  (→ https://my-app.loca.lt)"
                      className={inputCls}
                    />
                    <span className="mt-1 text-[11px] text-muted-foreground">
                      Leave blank for a random URL. Subdomains are not reserved and may already be taken.
                    </span>
                  </Field>
                </>
              )}

              {/* Tool availability banner for cloudflare / ngrok */}
              {toolName && (
                <div
                  className={cn(
                    "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs",
                    toolAvailable
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                      : downloadPhase === "complete"
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                      : downloadPhase === "error"
                      ? "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400"
                      : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                  )}
                >
                  {toolAvailable || downloadPhase === "complete" ? (
                    <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  <div className="flex-1 space-y-2">
                    {toolAvailable ? (
                      <span><strong>{toolName}</strong> is installed and ready.</span>
                    ) : downloadPhase === "downloading" ? (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="font-medium">Installing {toolName}â€¦</span>
                          <span className="tabular-nums text-[10px]">
                            {downloadedBytes > 0
                              ? `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB`
                              : "starting"}
                          </span>
                        </div>
                        {/* Animated indeterminate progress bar */}
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-500/20">
                          <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] rounded-full bg-amber-500" />
                        </div>
                        <p className="text-[11px] opacity-80">{downloadMessage}</p>
                      </>
                    ) : downloadPhase === "complete" ? (
                      <span><strong>{toolName}</strong> installed successfully. Ready to use.</span>
                    ) : downloadPhase === "error" ? (
                      <span>Installation failed. Check your connection and try again.</span>
                    ) : (
                      <>
                        <span>
                          <strong>{toolName}</strong> is not installed. Click Install to download it automatically.
                        </span>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            onClick={() => installMutation.mutate()}
                            disabled={installMutation.isPending}
                            className="flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-600 disabled:opacity-60"
                          >
                            <Download className="h-3 w-3" />
                            Install {toolName}
                          </button>
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

              {/* LAN vs internet explanation */}
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                <div className="mb-2 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  This address is only reachable on your local network
                </div>
                <p className="text-muted-foreground leading-relaxed">
                  The IP shown ({createdExposure.external_endpoint?.split(":")[0]}) is your
                  machine's <strong className="text-foreground">LAN address</strong>. Devices
                  on the same Wi-Fi or Ethernet can connect using it, but a VPS or any machine
                  on the internet cannot.
                </p>
                {publicIp && (
                  <div className="mt-2.5 rounded border border-border bg-muted/40 px-2.5 py-2">
                    <div className="mb-1 text-[11px] font-medium text-foreground">
                      Your public internet IP
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-foreground">
                        {publicIp}:{createdExposure.external_port}
                      </code>
                      <button
                        onClick={() => navigator.clipboard.writeText(`${publicIp}:${createdExposure.external_port}`).catch(() => {})}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Copy"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      To use this address from the internet you must add a{" "}
                      <strong className="text-foreground">port forwarding rule</strong> on your
                      router: forward external port <strong className="text-foreground">{createdExposure.external_port}</strong> →{" "}
                      <strong className="text-foreground">{createdExposure.external_endpoint}</strong>.
                    </p>
                  </div>
                )}
                <div className="mt-2.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <Router className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    For hassle-free internet access without router changes, use a{" "}
                    <strong className="text-foreground">Cloudflare Tunnel</strong> or{" "}
                    <strong className="text-foreground">ngrok</strong> exposure instead — they
                    punch through NAT automatically.
                  </span>
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
                disabled={!method || !!existingExposure}
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
                {previewMutation.isPending ? "Loadingâ€¦" : "Preview steps"}
              </button>
            )}
            {step === "preview" && (
              <button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {createMutation.isPending ? "Setting upâ€¦" : "Confirm & run"}
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
                    {firewallMutation.isPending ? "Configuringâ€¦" : "Configure firewall"}
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
