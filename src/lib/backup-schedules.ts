import { useEffect, useState, useCallback, useRef } from "react";
import { backupInstance } from "@/lib/tauri";
import type { LocalInstance } from "@/lib/tauri";

// ── Types ──────────────────────────────────────────────────────────────────

export type ScheduleInterval = 1 | 6 | 12 | 24 | 48 | 168;

export interface ScheduleConfig {
  enabled: boolean;
  intervalHours: ScheduleInterval;
  destinationDir: string;
  nextRun: string | null;   // ISO timestamp
  lastRun: string | null;
}

export interface RetentionConfig {
  keepLastN: number | null;   // null = unlimited
  maxAgeDays: number | null;  // null = unlimited
}

export interface InstanceBackupSettings {
  schedule: ScheduleConfig;
  retention: RetentionConfig;
  encryptEnabled: boolean;    // UI flag only — reserved for v0.2
}

type BackupScheduleStore = Record<string, InstanceBackupSettings>;

// ── Defaults ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "bp-backup-schedules";

export const defaultInstanceBackupSettings: InstanceBackupSettings = {
  schedule: {
    enabled: false,
    intervalHours: 24,
    destinationDir: "",
    nextRun: null,
    lastRun: null,
  },
  retention: {
    keepLastN: null,
    maxAgeDays: null,
  },
  encryptEnabled: false,
};

function loadStore(): BackupScheduleStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BackupScheduleStore) : {};
  } catch {
    return {};
  }
}

function saveStore(s: BackupScheduleStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useBackupSchedules() {
  const [store, setStore] = useState<BackupScheduleStore>(loadStore);

  const getSettings = useCallback(
    (instanceId: string): InstanceBackupSettings => {
      return store[instanceId] ?? defaultInstanceBackupSettings;
    },
    [store]
  );

  const updateSettings = useCallback(
    (instanceId: string, patch: Partial<InstanceBackupSettings>) => {
      setStore((prev) => {
        const current = prev[instanceId] ?? defaultInstanceBackupSettings;
        const next = {
          ...prev,
          [instanceId]: {
            ...current,
            ...patch,
            schedule: { ...current.schedule, ...(patch.schedule ?? {}) },
            retention: { ...current.retention, ...(patch.retention ?? {}) },
          },
        };
        saveStore(next);
        return next;
      });
    },
    []
  );

  const updateSchedule = useCallback(
    (instanceId: string, patch: Partial<ScheduleConfig>) => {
      setStore((prev) => {
        const current = prev[instanceId] ?? defaultInstanceBackupSettings;
        // If enabling with no dir → block (caller must validate, but don't corrupt state)
        const merged: ScheduleConfig = { ...current.schedule, ...patch };
        // Recalculate nextRun when interval or enabled changes
        if (
          (patch.intervalHours !== undefined || patch.enabled !== undefined) &&
          merged.enabled &&
          merged.destinationDir
        ) {
          const base = merged.lastRun ? new Date(merged.lastRun) : new Date();
          merged.nextRun = new Date(
            base.getTime() + merged.intervalHours * 60 * 60 * 1000
          ).toISOString();
        }
        if (!merged.enabled) {
          merged.nextRun = null;
        }
        const next = {
          ...prev,
          [instanceId]: { ...current, schedule: merged },
        };
        saveStore(next);
        return next;
      });
    },
    []
  );

  const updateRetention = useCallback(
    (instanceId: string, patch: Partial<RetentionConfig>) => {
      setStore((prev) => {
        const current = prev[instanceId] ?? defaultInstanceBackupSettings;
        const next = {
          ...prev,
          [instanceId]: {
            ...current,
            retention: { ...current.retention, ...patch },
          },
        };
        saveStore(next);
        return next;
      });
    },
    []
  );

  const markRan = useCallback((instanceId: string) => {
    setStore((prev) => {
      const current = prev[instanceId] ?? defaultInstanceBackupSettings;
      const now = new Date();
      const nextRun = new Date(
        now.getTime() + current.schedule.intervalHours * 60 * 60 * 1000
      ).toISOString();
      const next = {
        ...prev,
        [instanceId]: {
          ...current,
          schedule: {
            ...current.schedule,
            lastRun: now.toISOString(),
            nextRun,
          },
        },
      };
      saveStore(next);
      return next;
    });
  }, []);

  return { store, getSettings, updateSettings, updateSchedule, updateRetention, markRan };
}

// ── Schedule runner ────────────────────────────────────────────────────────
// Polls every 60 seconds and fires overdue scheduled backups.

export function useScheduleRunner(
  instances: LocalInstance[],
  store: BackupScheduleStore,
  markRan: (id: string) => void,
  onBackupFired?: (instanceName: string) => void
) {
  const storeRef = useRef(store);
  storeRef.current = store;
  const markRanRef = useRef(markRan);
  markRanRef.current = markRan;
  const cbRef = useRef(onBackupFired);
  cbRef.current = onBackupFired;

  useEffect(() => {
    async function tick() {
      const now = Date.now();
      for (const inst of instances) {
        if (inst.status !== "running") continue;
        const settings = storeRef.current[inst.id];
        if (!settings?.schedule.enabled) continue;
        if (!settings.schedule.destinationDir) continue;
        const nextRun = settings.schedule.nextRun;
        if (!nextRun || new Date(nextRun).getTime() > now) continue;
        // Overdue — fire backup
        try {
          await backupInstance({
            instance_id: inst.id,
            destination_dir: settings.schedule.destinationDir,
            note: "scheduled",
          });
          markRanRef.current(inst.id);
          cbRef.current?.(inst.name);
        } catch {
          // Don't crash the runner on individual failure
        }
      }
    }

    // Run once on mount then every 60s
    void tick();
    const id = setInterval(() => void tick(), 60_000);
    return () => clearInterval(id);
  }, [instances]);
}

// ── Interval labels ────────────────────────────────────────────────────────

export const INTERVAL_OPTIONS: { value: ScheduleInterval; label: string }[] = [
  { value: 1,   label: "Every hour" },
  { value: 6,   label: "Every 6 hours" },
  { value: 12,  label: "Every 12 hours" },
  { value: 24,  label: "Daily" },
  { value: 48,  label: "Every 2 days" },
  { value: 168, label: "Weekly" },
];
