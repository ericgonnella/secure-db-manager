import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Eye, EyeOff, Globe, Lock, X } from "lucide-react";
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

/**
 * Replace anything that looks like a password inside a connection string
 * with a fixed-width mask. Covers the common URI form (`scheme://user:PASS@host`)
 * as well as CLI-style flags such as `-p'PASS'`, `-a 'PASS'`, `password=PASS`,
 * `PGPASSWORD=PASS`, `MYSQL_PWD=PASS`, etc. Designed to be conservative — if
 * we cannot confidently identify the secret we leave the string alone so the
 * user can still copy a working command.
 */
function maskPasswordInString(value: string, password: string | undefined): string {
  if (!password) return value;
  // Only mask reasonably-long secrets to avoid mangling unrelated substrings.
  if (password.length < 4) return value;
  // Replace every literal occurrence (covers URI userinfo and bare CLI args).
  // Also replace the URL-encoded form, which is what `connection-strings.ts`
  // emits inside `scheme://user:ENCODED@host` URIs.
  const encoded = encodeURIComponent(password);
  let out = value.split(password).join("********");
  if (encoded !== password) {
    out = out.split(encoded).join("********");
  }
  return out;
}

function StringRow({
  entry,
  password,
  reveal,
}: {
  entry: ConnectionString;
  password: string | undefined;
  reveal: boolean;
}) {
  const display = reveal
    ? entry.value
    : maskPasswordInString(entry.value, password);
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
          {display}
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
    // Refetch every 5s so the External tab stays current with tunnel URL changes
    // (e.g. Cloudflare regenerate, ngrok restart) while the modal is open.
    refetchInterval: 5000,
  });

  const activeExposure = exposures.find(
    (e) => e.instance_id === instance.id && e.status === "active"
  );

  const sets = creds
    ? buildConnectionStrings(instance, creds, activeExposure)
    : null;

  const hasExternal = (sets?.external.length ?? 0) > 0;

  // Passwords are masked by default; the user must explicitly reveal them.
  // The reveal state always resets to `false` whenever the modal mounts for a
  // different instance so we never carry a previously-revealed state across
  // accidental remounts.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    setRevealed(false);
  }, [instance.id]);
  const password = useMemo(() => creds?.password, [creds]);

  // Auto-switch tabs based on whether external strings exist:
  // - If exposure goes away while on External → fall back to Local.
  // - If exposure becomes available while on Local (and the user hasn't
  //   explicitly switched away) → surface the new External tab.
  const [hasAutoSwitched, setHasAutoSwitched] = useState(false);
  useEffect(() => {
    if (!hasExternal && tab === "external") setTab("internal");
    if (hasExternal && !hasAutoSwitched && tab === "internal") {
      setTab("external");
      setHasAutoSwitched(true);
    }
  }, [hasExternal, tab, hasAutoSwitched]);

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
          ) : !sets ? null : (
            <div className="space-y-4">
              {/* Credential warning + reveal toggle */}
              <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <div className="flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    These strings contain database credentials. Avoid pasting
                    them into chat, screenshots, or shared logs.
                  </span>
                </div>
                <button
                  onClick={() => setRevealed((r) => !r)}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                  title={revealed ? "Hide passwords" : "Show passwords"}
                >
                  {revealed ? (
                    <>
                      <EyeOff className="h-3 w-3" /> Hide
                    </>
                  ) : (
                    <>
                      <Eye className="h-3 w-3" /> Reveal
                    </>
                  )}
                </button>
              </div>

              {tab === "internal" ? (
                sets.internal.map((entry, idx) => (
                  <StringRow
                    key={`int-${idx}`}
                    entry={entry}
                    password={password}
                    reveal={revealed}
                  />
                ))
              ) : (
                <>
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
                    <StringRow
                      key={`ext-${idx}`}
                      entry={entry}
                      password={password}
                      reveal={revealed}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-6 py-3">
          <p className="text-[11px] text-muted-foreground">
            Passwords are URL-encoded and masked by default. Copying still
            copies the real value — treat these strings as secrets.
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
