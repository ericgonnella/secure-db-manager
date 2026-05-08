import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Copy, Check, ExternalLink, Pencil, Save, X as XIcon } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import {
  getWebAppConnectionInfo,
  listLocalInstances,
  updateWebAppLinkedInstances,
  type WebApp,
  type LocalInstance,
} from "@/lib/tauri";

const BROWSER_FRIENDLY = new Set(["pocketbase", "clickhouse"]);

interface Props {
  webApp: WebApp;
  onClose: () => void;
}

function CopyBtn({ text }: { text: string }) {
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

export function WebAppConnectionInfo({ webApp, onClose }: Props) {
  const qc = useQueryClient();
  const [editingLinks, setEditingLinks] = useState(false);
  const [draftIds, setDraftIds] = useState<string[]>(webApp.linked_instance_ids);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["web-app-connection", webApp.id],
    queryFn: () => getWebAppConnectionInfo(webApp.id),
  });

  const { data: allInstances = [] } = useQuery<LocalInstance[]>({
    queryKey: ["local-instances"],
    queryFn: listLocalInstances,
  });

  const saveLinksMut = useMutation({
    mutationFn: () => updateWebAppLinkedInstances(webApp.id, draftIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["web-app-connection", webApp.id] });
      qc.invalidateQueries({ queryKey: ["web-apps"] });
      setSaveError(null);
      setEditingLinks(false);
    },
    onError: (err) => setSaveError(String(err)),
  });

  function toggleDraft(id: string) {
    setDraftIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold">Connection Info</h2>
            <p className="text-xs text-muted-foreground">{webApp.name}</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {isLoading && (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {String(error)}
            </div>
          )}

          {data && (
            <>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Web App URL
                </div>
                <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
                  <span className="flex-1 truncate">{data.web_app_url}</span>
                  <button
                    onClick={() => openUrl(data.web_app_url)}
                    className="text-muted-foreground hover:text-foreground"
                    title="Open in browser"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                  <CopyBtn text={data.web_app_url} />
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2">
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Linked Databases
                  </div>
                  {!editingLinks && (
                    <button
                      onClick={() => {
                        setDraftIds(webApp.linked_instance_ids);
                        setSaveError(null);
                        setEditingLinks(true);
                      }}
                      className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </button>
                  )}
                </div>

                {editingLinks ? (
                  <div className="rounded-md border border-border bg-background">
                    <div className="max-h-48 divide-y divide-border overflow-y-auto">
                      {allInstances.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          No local instances found.
                        </p>
                      ) : (
                        allInstances.map((inst) => {
                          const friendly = BROWSER_FRIENDLY.has(inst.service_type);
                          const checked = draftIds.includes(inst.id);
                          return (
                            <label
                              key={inst.id}
                              className={cn(
                                "flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-muted",
                                checked && "bg-muted/60",
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleDraft(inst.id)}
                              />
                              <span className="flex-1 font-medium">{inst.name}</span>
                              <span className="text-muted-foreground">{inst.service_type}</span>
                              <span
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                                  friendly
                                    ? "bg-emerald-500/10 text-emerald-500"
                                    : "bg-amber-500/10 text-amber-500",
                                )}
                              >
                                {friendly ? "browser" : "backend"}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                    {saveError && (
                      <div className="border-t border-border px-3 py-2 text-[11px] text-red-400">
                        {saveError}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
                      <button
                        onClick={() => setEditingLinks(false)}
                        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                      >
                        <XIcon className="h-3 w-3" />
                        Cancel
                      </button>
                      <button
                        onClick={() => saveLinksMut.mutate()}
                        disabled={saveLinksMut.isPending}
                        className="flex items-center gap-1 rounded bg-blue-500 px-2 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                      >
                        <Save className="h-3 w-3" />
                        {saveLinksMut.isPending ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                ) : data.connections.length === 0 ? (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    None linked.{" "}
                    <button
                      onClick={() => {
                        setDraftIds(webApp.linked_instance_ids);
                        setEditingLinks(true);
                      }}
                      className="text-blue-400 underline-offset-2 hover:underline"
                    >
                      Add databases
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {data.connections.map((c) => (
                      <div
                        key={c.instance_id}
                        className={cn(
                          "rounded-md border bg-background p-3",
                          c.browser_compatible
                            ? "border-emerald-500/30"
                            : "border-amber-500/30",
                        )}
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {c.instance_name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {c.service_type}
                          </span>
                          <span
                            className={cn(
                              "ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                              c.browser_compatible
                                ? "bg-emerald-500/10 text-emerald-500"
                                : "bg-amber-500/10 text-amber-500",
                            )}
                          >
                            {c.browser_compatible ? "browser" : "backend only"}
                          </span>
                        </div>

                        {c.proxy_url && (
                          <div className="mb-2">
                            <div className="mb-1 text-[10px] uppercase text-muted-foreground">
                              Proxy URL
                            </div>
                            <div className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 font-mono text-xs">
                              <span className="flex-1 truncate">
                                {c.proxy_url}
                              </span>
                              <CopyBtn text={c.proxy_url} />
                            </div>
                          </div>
                        )}

                        {c.direct_uri && (
                          <div className="mb-2">
                            <div className="mb-1 text-[10px] uppercase text-muted-foreground">
                              Internal URI (server-side only)
                            </div>
                            <div className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 font-mono text-xs">
                              <span className="flex-1 truncate">
                                {c.direct_uri}
                              </span>
                              <CopyBtn text={c.direct_uri} />
                            </div>
                          </div>
                        )}

                        {c.sdk_snippet && (
                          <div>
                            <div className="mb-1 text-[10px] uppercase text-muted-foreground">
                              SDK Snippet
                            </div>
                            <pre className="overflow-x-auto rounded border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">
                              {c.sdk_snippet}
                            </pre>
                          </div>
                        )}

                        {c.note && (
                          <p className="mt-2 text-[11px] text-amber-500/90">
                            {c.note}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
