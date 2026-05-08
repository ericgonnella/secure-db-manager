import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { X, Folder, AppWindow, ChevronDown, AlertTriangle, CheckCircle, Loader2, Globe, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createWebApp,
  detectWebProject,
  listLocalInstances,
  type CreateWebAppInput,
  type LocalInstance,
  type WebAppMode,
  type WebProjectDetection,
} from "@/lib/tauri";
import { useProjects } from "@/lib/projects";

interface Props {
  onClose: () => void;
}

const BROWSER_FRIENDLY = new Set(["pocketbase", "clickhouse"]);

type BuildPreset = {
  label: string;
  command: string;
  outputDir: string;
  hint?: string;
};

const BUILD_PRESETS: BuildPreset[] = [
  { label: "None — serve folder directly", command: "", outputDir: "", hint: "For plain HTML/CSS/JS. Folder must contain index.html." },
  { label: "npm run build", command: "npm run build", outputDir: "dist" },
  { label: "pnpm run build", command: "pnpm run build", outputDir: "dist" },
  { label: "yarn build", command: "yarn build", outputDir: "dist" },
  { label: "bun run build", command: "bun run build", outputDir: "dist" },
  { label: "vite build", command: "vite build", outputDir: "dist" },
  { label: "next build (static export)", command: "next build", outputDir: "out", hint: "Requires output: 'export' in next.config. API routes won't work." },
  { label: "Other…", command: "__custom__", outputDir: "" },
];

export function CreateWebAppWizard({ onClose }: Props) {
  const qc = useQueryClient();
  const { currentProjectId } = useProjects();
  const [name, setName] = useState("");
  const [port, setPort] = useState("8080");
  const [mode, setMode] = useState<WebAppMode>("dev");
  const [srcPath, setSrcPath] = useState<string>("");
  const [selectedPreset, setSelectedPreset] = useState<BuildPreset>(BUILD_PRESETS[0]);
  const [customCommand, setCustomCommand] = useState("");
  const [buildOutputDir, setBuildOutputDir] = useState("");
  const [linkedIds, setLinkedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detection, setDetection] = useState<WebProjectDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [containerType, setContainerType] = useState<"nginx" | "nodejs">("nginx");
  const [nodejsStartCmd, setNodejsStartCmd] = useState("");
  const [nodejsAppPort, setNodejsAppPort] = useState("3000");

  const buildCommand = selectedPreset.command === "__custom__"
    ? customCommand
    : selectedPreset.command;

  const { data: instances = [] } = useQuery<LocalInstance[]>({
    queryKey: ["local-instances"],
    queryFn: listLocalInstances,
  });

  const createMut = useMutation({
    mutationFn: (input: CreateWebAppInput) => createWebApp(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["web-apps"] });
      onClose();
    },
    onError: (err) => setError(String(err)),
  });

  function handlePresetChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const preset = BUILD_PRESETS.find((p) => p.label === e.target.value) ?? BUILD_PRESETS[0];
    setSelectedPreset(preset);
    // Auto-fill output dir from preset, but only if the user hasn't manually changed it
    if (preset.command !== "__custom__") {
      setBuildOutputDir(preset.outputDir);
    }
  }

  async function pickFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setSrcPath(selected);
    setDetection(null);
    setDetecting(true);
    try {
      const result = await detectWebProject(selected);
      setDetection(result);
      // Auto-apply suggested preset
      if (result.suggested_build_command) {
        const match = BUILD_PRESETS.find(
          (p) => p.command === result.suggested_build_command
        );
        if (match) {
          setSelectedPreset(match);
        } else {
          const other = BUILD_PRESETS.find((p) => p.command === "__custom__")!;
          setSelectedPreset(other);
          setCustomCommand(result.suggested_build_command);
        }
      } else {
        setSelectedPreset(BUILD_PRESETS[0]);
      }
      if (result.suggested_output_dir) {
        setBuildOutputDir(result.suggested_output_dir);
      }
      // Auto-select container type and Node.js fields from detection
      const ct = result.suggested_container_type === "nodejs" ? "nodejs" : "nginx";
      setContainerType(ct);
      if (result.suggested_start_command) {
        setNodejsStartCmd(result.suggested_start_command);
      }
      if (result.suggested_app_port != null) {
        setNodejsAppPort(String(result.suggested_app_port));
      }
    } catch {
      // Detection is best-effort — ignore failures
    } finally {
      setDetecting(false);
    }
  }

  function toggleLink(id: string) {
    setLinkedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function submit() {
    setError(null);
    const portNum = parseInt(port, 10);
    if (!name.trim()) return setError("Name is required.");
    if (!Number.isFinite(portNum) || portNum < 1024 || portNum > 65535) {
      return setError("Port must be between 1024 and 65535.");
    }
    if (containerType === "nodejs") {
      if (!srcPath) return setError("Node.js container requires a project folder.");
      if (!nodejsStartCmd.trim()) {
        return setError("Node.js container requires a start command.");
      }
    } else if (mode === "dev" && !srcPath) {
      return setError("Dev mode requires a folder.");
    }
    if (selectedPreset.command === "__custom__" && !customCommand.trim() && containerType === "nginx") {
      return setError("Enter a custom build command or choose 'None'.");
    }
    const appPortNum = parseInt(nodejsAppPort, 10);
    createMut.mutate({
      name: name.trim(),
      port: portNum,
      mode: containerType === "nodejs" ? "dev" : mode,
      src_path: srcPath || null,
      build_command: buildCommand.trim() || null,
      build_output_dir: containerType === "nodejs" ? "" : buildOutputDir.trim(),
      container_type: containerType,
      nodejs_start_command:
        containerType === "nodejs" ? (nodejsStartCmd.trim() || null) : null,
      nodejs_app_port:
        containerType === "nodejs"
          ? Number.isFinite(appPortNum) && appPortNum > 0
            ? appPortNum
            : 3000
          : undefined,
      linked_instance_ids: linkedIds,
      project_id: currentProjectId,
    });
  }

  const hasBuild =
    (mode === "dev" || containerType === "nodejs") &&
    buildCommand.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <AppWindow className="h-4 w-4 text-blue-500" />
            <h2 className="text-sm font-semibold">New Web App</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          {/* Name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-frontend"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
            />
          </div>

          {/* Port */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Host Port
            </label>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="8080"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
            />
          </div>

          {/* Project folder — always shown; needed for both nginx and nodejs */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Project Folder
            </label>
            <div className="flex items-center gap-2">
              <input
                value={srcPath}
                readOnly
                placeholder="No folder selected"
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground"
              />
              <button
                onClick={pickFolder}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                <Folder className="h-3.5 w-3.5" />
                Browse
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              We'll auto-detect the framework and pick the right runtime.
            </p>
          </div>

          {/* Detection banner */}
          {detecting && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              Detecting project type…
            </div>
          )}
          {detection && !detecting && (
            <div className={cn(
              "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
              detection.compatible
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                : "border-red-500/30 bg-red-500/5 text-red-400",
            )}>
              {detection.compatible
                ? <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              }
              <div className="space-y-0.5">
                <p className="font-medium">
                  {detection.project_type.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  {detection.package_manager ? ` · ${detection.package_manager}` : ""}
                  {" — "}
                  {detection.compatible ? "compatible" : "incompatible"}
                  {detection.suggested_container_type === "nodejs" ? " (Node.js)" : " (nginx)"}
                </p>
                {detection.compatibility_note && (
                  <p className="text-[11px] opacity-80">{detection.compatibility_note}</p>
                )}
              </div>
            </div>
          )}

          {/* Container type toggle — choose runtime once a folder is selected */}
          {srcPath && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Container Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(["nginx", "nodejs"] as const).map((ct) => (
                  <button
                    key={ct}
                    onClick={() => setContainerType(ct)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-left transition-colors",
                      containerType === ct
                        ? "border-blue-500 bg-blue-500/10"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      {ct === "nginx" ? (
                        <Globe className="h-3.5 w-3.5" />
                      ) : (
                        <Terminal className="h-3.5 w-3.5" />
                      )}
                      {ct === "nginx" ? "nginx (static)" : "Node.js"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {ct === "nginx"
                        ? "Serve built static files"
                        : "Run a Node.js server"}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Mode (nginx only — nodejs always bind-mounts) */}
          {containerType === "nginx" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Mode
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(["dev", "deploy"] as WebAppMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-left transition-colors",
                      mode === m
                        ? "border-blue-500 bg-blue-500/10"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <div className="text-sm font-medium capitalize">{m}</div>
                    <div className="text-xs text-muted-foreground">
                      {m === "dev"
                        ? "Build + live bind-mount"
                        : "Copy build into volume"}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Build & runtime settings — shown for nginx-dev OR nodejs */}
          {(mode === "dev" || containerType === "nodejs") && (
            <>
              {/* Build command */}
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Build Command
                </label>
                <div className="relative">
                  <select
                    value={selectedPreset.label}
                    onChange={handlePresetChange}
                    className="w-full appearance-none rounded-md border border-border bg-background px-3 py-1.5 pr-8 text-sm outline-none focus:border-ring"
                  >
                    {BUILD_PRESETS.map((p) => (
                      <option key={p.label} value={p.label}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
                {selectedPreset.hint && (
                  <p className="mt-1 text-[11px] text-amber-400">{selectedPreset.hint}</p>
                )}
                {selectedPreset.command === "__custom__" && (
                  <input
                    value={customCommand}
                    onChange={(e) => setCustomCommand(e.target.value)}
                    placeholder="e.g. cargo build --release"
                    className="mt-2 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:border-ring"
                    autoFocus
                  />
                )}
              </div>

              {/* nginx output dir */}
              {hasBuild && containerType === "nginx" && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Build Output Dir
                    <span className="ml-1.5 font-normal text-muted-foreground/70">
                      (relative to project folder)
                    </span>
                  </label>
                  <input
                    value={buildOutputDir}
                    onChange={(e) => setBuildOutputDir(e.target.value)}
                    placeholder="dist"
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:border-ring"
                  />
                  {srcPath && buildOutputDir && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      nginx will serve: <span className="font-mono">{srcPath}/{buildOutputDir}</span>
                    </p>
                  )}
                </div>
              )}

              {!hasBuild && containerType === "nginx" && (
                <p className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-[11px] text-blue-400">
                  No build step — nginx will serve the selected folder directly.
                  Works great for plain HTML/CSS/JS projects. Just make sure the
                  folder contains an <code>index.html</code>.
                </p>
              )}

              {/* Node.js fields */}
              {containerType === "nodejs" && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Start Command
                    </label>
                    <input
                      value={nodejsStartCmd}
                      onChange={(e) => setNodejsStartCmd(e.target.value)}
                      placeholder="node server.js"
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:border-ring"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Runs inside a <span className="font-mono">node:lts-alpine</span> container with your folder bind-mounted at <span className="font-mono">/app</span>.
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      App Port
                      <span className="ml-1.5 font-normal text-muted-foreground/70">
                        (port your app listens on inside the container)
                      </span>
                    </label>
                    <input
                      value={nodejsAppPort}
                      onChange={(e) => setNodejsAppPort(e.target.value)}
                      placeholder="3000"
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:border-ring"
                    />
                  </div>
                </>
              )}
            </>
          )}

          {/* Linked DB instances */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Link Database Instances ({linkedIds.length})
            </label>
            {instances.length === 0 ? (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                No instances yet.
              </div>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-1">
                {instances.map((inst) => {
                  const friendly = BROWSER_FRIENDLY.has(inst.service_type);
                  const checked = linkedIds.includes(inst.id);
                  return (
                    <label
                      key={inst.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted",
                        checked && "bg-muted",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleLink(inst.id)}
                      />
                      <span className="flex-1 truncate font-medium">
                        {inst.name}
                      </span>
                      <span className="text-muted-foreground">
                        {inst.service_type}
                      </span>
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
                })}
              </div>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              PocketBase &amp; ClickHouse are reachable from the browser via
              proxy. Other databases need a server-side layer.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={createMut.isPending}
            className="rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {createMut.isPending ? "Building & Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

