import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Sun,
  Moon,
  Monitor,
  Type,
  Eye,
  Zap,
  Target,
  FolderOpen,
  Copy,
  Check,
  Trash2,
  Pencil,
  Plus,
  AlertTriangle,
  RotateCcw,
  ExternalLink,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings, defaultSettings, type AppSettings } from "@/lib/settings";
import { useProjects } from "@/lib/projects";

// ── Page ──────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { settings, update, reset } = useSettings();

  return (
    <div className="mx-auto max-w-3xl space-y-8 pb-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Personalize how Baseport looks and behaves. Changes apply
            immediately and are saved to this device.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (
              confirm(
                "Reset all appearance and accessibility settings to defaults? Projects and instances are not affected."
              )
            ) {
              reset();
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset to defaults
        </button>
      </header>

      <AppearanceSection settings={settings} update={update} />
      <AccessibilitySection settings={settings} update={update} />
      <ProjectsSection />
      <DataStorageSection settings={settings} update={update} />
      <AboutSection />
    </div>
  );
}

// ── Section primitive ─────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium text-foreground"
        >
          {label}
        </label>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ── Segmented control ─────────────────────────────────────────────────────

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  ariaLabel?: string;
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-border bg-background p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.ariaLabel ?? opt.label}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Toggle (switch) ───────────────────────────────────────────────────────

function Toggle({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        checked ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition",
          checked ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

// ── Appearance ────────────────────────────────────────────────────────────

function AppearanceSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
  return (
    <Section
      title="Appearance"
      description="Theme and text size for this device."
    >
      <Row
        label="Theme"
        description="System matches your operating system preference."
      >
        <Segmented
          ariaLabel="Theme"
          value={settings.theme}
          onChange={(v) => update({ theme: v })}
          options={[
            { value: "light", label: "Light", icon: <Sun className="h-3.5 w-3.5" /> },
            { value: "system", label: "System", icon: <Monitor className="h-3.5 w-3.5" /> },
            { value: "dark", label: "Dark", icon: <Moon className="h-3.5 w-3.5" /> },
          ]}
        />
      </Row>

      <Row
        label="Text size"
        description="Increase the base font size across the entire app."
      >
        <Segmented
          ariaLabel="Text size"
          value={settings.fontSize}
          onChange={(v) => update({ fontSize: v })}
          options={[
            { value: "default", label: "Default", icon: <Type className="h-3.5 w-3.5" /> },
            { value: "lg", label: "Large" },
            { value: "xl", label: "Extra large" },
          ]}
        />
      </Row>
    </Section>
  );
}

// ── Accessibility ─────────────────────────────────────────────────────────

function AccessibilitySection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
  return (
    <Section
      title="Accessibility"
      description="Tweak motion, contrast, and focus behavior to suit your needs."
    >
      <Row
        label="Reduce motion"
        description="Disables transitions and animations. Helpful for users with vestibular sensitivity or motion-induced discomfort."
        htmlFor="bp-reduced-motion"
      >
        <Toggle
          id="bp-reduced-motion"
          label="Reduce motion"
          checked={settings.reducedMotion}
          onChange={(v) => update({ reducedMotion: v })}
        />
      </Row>

      <Row
        label="High contrast borders"
        description="Strengthens borders and secondary text for low-vision users or bright environments."
        htmlFor="bp-high-contrast"
      >
        <Toggle
          id="bp-high-contrast"
          label="High contrast borders"
          checked={settings.highContrast}
          onChange={(v) => update({ highContrast: v })}
        />
      </Row>

      <Row
        label="Always show focus rings"
        description="Keeps the focus outline visible at all times — useful when alternating between mouse and keyboard."
        htmlFor="bp-focus-always"
      >
        <Toggle
          id="bp-focus-always"
          label="Always show focus rings"
          checked={settings.focusRingAlways}
          onChange={(v) => update({ focusRingAlways: v })}
        />
      </Row>
    </Section>
  );
}

// ── Projects ──────────────────────────────────────────────────────────────

function ProjectsSection() {
  const { projects, currentProjectId, createProject, renameProject, deleteProject } =
    useProjects();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  function startEdit(id: string, current: string) {
    setEditingId(id);
    setEditValue(current);
  }

  function commitEdit() {
    if (editingId && editValue.trim()) {
      renameProject(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue("");
  }

  function commitCreate() {
    const trimmed = newName.trim();
    if (trimmed) {
      createProject(trimmed);
    }
    setCreating(false);
    setNewName("");
  }

  return (
    <Section
      title="Projects"
      description="Organize your instances into projects. The default project cannot be removed."
    >
      <div className="px-5 py-4">
        <ul className="divide-y divide-border rounded-md border border-border">
          {projects.map((p) => {
            const isDefault = p.id === "default";
            const isCurrent = p.id === currentProjectId;
            const isEditing = editingId === p.id;
            return (
              <li
                key={p.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") {
                          setEditingId(null);
                          setEditValue("");
                        }
                      }}
                      aria-label={`Rename ${p.name}`}
                      className="w-full rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">
                        {p.name}
                      </span>
                      {isCurrent && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Current
                        </span>
                      )}
                      {isDefault && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Default
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {!isEditing && (
                  <div className="flex items-center gap-1">
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => startEdit(p.id, p.name)}
                        aria-label={`Rename ${p.name}`}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            confirm(
                              `Delete project "${p.name}"? Instances inside will remain but become unreachable until you reassign them.`
                            )
                          ) {
                            deleteProject(p.id);
                          }
                        }}
                        aria-label={`Delete ${p.name}`}
                        className="rounded p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-3">
          {creating ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreate();
                  if (e.key === "Escape") {
                    setCreating(false);
                    setNewName("");
                  }
                }}
                placeholder="Project name"
                aria-label="New project name"
                className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button
                type="button"
                onClick={commitCreate}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                }}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
              New project
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}

// ── Data & Storage ────────────────────────────────────────────────────────

function DataStorageSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const { data: dataDir } = useQuery({
    queryKey: ["data-dir"],
    queryFn: () => invoke<string>("get_data_dir"),
    staleTime: Infinity,
  });

  async function copyDir() {
    if (!dataDir) return;
    try {
      await navigator.clipboard.writeText(dataDir);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function openFolder() {
    try {
      await invoke("open_data_dir");
    } catch (e) {
      alert(`Could not open folder: ${e}`);
    }
  }

  async function doClear() {
    setClearing(true);
    setClearError(null);
    try {
      await invoke<number>("clear_audit_log");
      await queryClient.invalidateQueries({ queryKey: ["audit-logs"] });
      setConfirmingClear(false);
    } catch (e) {
      setClearError(String(e));
    } finally {
      setClearing(false);
    }
  }

  return (
    <Section
      title="Data & storage"
      description="Where Baseport keeps your local store, and tools for cleaning it up."
    >
      <Row
        label="Data folder"
        description="JSON store, container metadata, and backups live here."
      >
        <div className="flex items-center gap-2">
          <code className="max-w-[260px] truncate rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
            {dataDir ?? "Loading…"}
          </code>
          <button
            type="button"
            onClick={copyDir}
            disabled={!dataDir}
            aria-label="Copy data folder path"
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={openFolder}
            disabled={!dataDir}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open folder
          </button>
        </div>
      </Row>

      <Row
        label="Audit log retention"
        description="Older audit events are hidden from the UI. The store itself is only trimmed when you clear it."
        htmlFor="bp-audit-retention"
      >
        <select
          id="bp-audit-retention"
          value={settings.auditRetentionDays}
          onChange={(e) =>
            update({
              auditRetentionDays: Number(e.target.value) as AppSettings["auditRetentionDays"],
            })
          }
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
          <option value={-1}>Forever</option>
        </select>
      </Row>

      <Row
        label="Clear audit log"
        description="Permanently deletes every recorded audit event. This cannot be undone."
      >
        {!confirmingClear ? (
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear audit log
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-red-500">
              <AlertTriangle className="h-3.5 w-3.5" />
              Confirm?
            </span>
            <button
              type="button"
              onClick={doClear}
              disabled={clearing}
              className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              {clearing ? "Clearing…" : "Yes, delete"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingClear(false);
                setClearError(null);
              }}
              disabled={clearing}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        )}
      </Row>
      {clearError && (
        <div className="border-t border-border bg-red-500/5 px-5 py-2 text-xs text-red-500">
          {clearError}
        </div>
      )}
    </Section>
  );
}

// ── About ─────────────────────────────────────────────────────────────────

function AboutSection() {
  return (
    <Section title="About">
      <div className="grid grid-cols-1 gap-3 px-5 py-4 text-sm sm:grid-cols-2">
        <AboutItem icon={<Info className="h-4 w-4" />} label="App">
          Baseport
        </AboutItem>
        <AboutItem icon={<Eye className="h-4 w-4" />} label="Version">
          0.1.0
        </AboutItem>
        <AboutItem icon={<Target className="h-4 w-4" />} label="Identifier">
          <code className="text-xs">com.ericg.baseport</code>
        </AboutItem>
        <AboutItem icon={<Zap className="h-4 w-4" />} label="Engine">
          Tauri 2 · React 18
        </AboutItem>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-background/50 px-5 py-3">
        <button
          type="button"
          onClick={() => {
            openUrl("https://github.com/ericgilliam/secure-db-manager").catch(() => {
              /* ignore */
            });
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </button>
      </div>
    </Section>
  );
}

function AboutItem({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="text-sm text-foreground">{children}</div>
      </div>
    </div>
  );
}

// Reference defaultSettings to satisfy unused-export hygiene checks if needed.
void defaultSettings;
