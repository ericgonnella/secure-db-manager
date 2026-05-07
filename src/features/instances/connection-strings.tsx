import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Globe, Lock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildConnectionStrings,
  type ConnectionString,
} from "@/lib/connection-strings";
import {
  getInstanceCredentials,
  listExposures,
  type LocalInstance,
} from "@/lib/tauri";

interface Props {
  instance: LocalInstance;
  onClose: () => void;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* noop */
        }
      }}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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

function StringRow({ entry }: { entry: ConnectionString }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {entry.label}
        </span>
        {entry.description && (
          <span className="text-[11px] text-muted-foreground/70">
            — {entry.description}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5">
        <code className="flex-1 truncate font-mono text-xs text-foreground">
          {entry.value}
        </code>
        <CopyButton value={entry.value} />
      </div>
    </div>
  );
}

export function ConnectionStringsModal({ instance, onClose }: Props) {
  const [tab, setTab] = useState<"internal" | "external">("internal");

  const { data: creds, isLoading: credsLoading, error } = useQuery({
    queryKey: ["instance-credentials", instance.id],
    queryFn: () => getInstanceCredentials(instance.id),
  });
  const { data: exposures = [] } = useQuery({
    queryKey: ["exposures"],
    queryFn: listExposures,
  });

  const activeExposure = exposures.find(
    (e) => e.instance_id === instance.id && e.status === "active"
  );

  const sets = creds
    ? buildConnectionStrings(instance, creds, activeExposure)
    : null;

  const hasExternal = (sets?.external.length ?? 0) > 0;

  // If no external strings, force internal tab
  useEffect(() => {
    if (!hasExternal && tab === "external") setTab("internal");
  }, [hasExternal, tab]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">
              Connection Strings — {instance.name}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              One-click copy for{" "}
              <span className="font-mono">{instance.service_type}</span> client
              tools
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border px-6 pt-3">
          <button
            onClick={() => setTab("internal")}
            className={cn(
              "flex items-center gap-1.5 rounded-t-md px-3 py-2 text-xs font-medium transition-colors",
              tab === "internal"
                ? "border-b-2 border-primary text-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Lock className="h-3.5 w-3.5" />
            Local
          </button>
          <button
            onClick={() => setTab("external")}
            disabled={!hasExternal}
            className={cn(
              "flex items-center gap-1.5 rounded-t-md px-3 py-2 text-xs font-medium transition-colors",
              tab === "external"
                ? "border-b-2 border-primary text-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-foreground",
              !hasExternal && "cursor-not-allowed opacity-40"
            )}
            title={
              hasExternal
                ? "Public exposure endpoint"
                : "No active exposure for this instance"
            }
          >
            <Globe className="h-3.5 w-3.5" />
            External
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {credsLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Loading credentials…
            </p>
          ) : error ? (
            <p className="py-8 text-center text-sm text-destructive">
              Failed to load credentials.
            </p>
          ) : !sets ? null : tab === "internal" ? (
            <div className="space-y-4">
              {sets.internal.map((entry, idx) => (
                <StringRow key={`int-${idx}`} entry={entry} />
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {activeExposure?.external_endpoint && (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Routed via{" "}
                  <span className="font-mono text-foreground">
                    {activeExposure.method}
                  </span>{" "}
                  →{" "}
                  <span className="font-mono text-foreground">
                    {activeExposure.external_endpoint}
                  </span>
                </div>
              )}
              {sets.external.map((entry, idx) => (
                <StringRow key={`ext-${idx}`} entry={entry} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-6 py-3">
          <p className="text-[11px] text-muted-foreground">
            Passwords are URL-encoded. Treat these strings as secrets.
          </p>
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
