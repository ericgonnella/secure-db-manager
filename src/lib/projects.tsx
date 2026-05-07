import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

// ── Types ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
}

interface ProjectsContext {
  projects: Project[];
  currentProjectId: string;
  setCurrentProjectId: (id: string) => void;
  createProject: (name: string) => Project;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_PROJECT: Project = { id: "default", name: "Default Project" };
const STORAGE_KEY_PROJECTS = "sdm-projects";
const STORAGE_KEY_CURRENT = "sdm-current-project";

function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROJECTS);
    if (raw) {
      const parsed = JSON.parse(raw) as Project[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Always ensure the default project is present
        if (!parsed.find((p) => p.id === "default")) {
          return [DEFAULT_PROJECT, ...parsed];
        }
        return parsed;
      }
    }
  } catch {}
  return [DEFAULT_PROJECT];
}

function saveProjects(projects: Project[]) {
  localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
}

function loadCurrentProjectId(projects: Project[]): string {
  const stored = localStorage.getItem(STORAGE_KEY_CURRENT) ?? "default";
  return projects.find((p) => p.id === stored) ? stored : "default";
}

// ── Context ───────────────────────────────────────────────────────────────

const Ctx = createContext<ProjectsContext | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>(() => loadProjects());
  const [currentProjectId, setCurrentProjectIdState] = useState<string>(() =>
    loadCurrentProjectId(loadProjects())
  );

  const setCurrentProjectId = useCallback((id: string) => {
    setCurrentProjectIdState(id);
    localStorage.setItem(STORAGE_KEY_CURRENT, id);
  }, []);

  const createProject = useCallback((name: string): Project => {
    const id = `project_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const project: Project = { id, name: name.trim() };
    setProjects((prev) => {
      const next = [...prev, project];
      saveProjects(next);
      return next;
    });
    return project;
  }, []);

  const renameProject = useCallback((id: string, name: string) => {
    if (id === "default") return; // default project name is fixed
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, name: name.trim() } : p));
      saveProjects(next);
      return next;
    });
  }, []);

  const deleteProject = useCallback(
    (id: string) => {
      if (id === "default") return; // cannot delete the default project
      setProjects((prev) => {
        const next = prev.filter((p) => p.id !== id);
        saveProjects(next);
        return next;
      });
      if (currentProjectId === id) {
        setCurrentProjectId("default");
      }
    },
    [currentProjectId, setCurrentProjectId]
  );

  return (
    <Ctx.Provider
      value={{
        projects,
        currentProjectId,
        setCurrentProjectId,
        createProject,
        renameProject,
        deleteProject,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useProjects(): ProjectsContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProjects must be used inside ProjectProvider");
  return ctx;
}
