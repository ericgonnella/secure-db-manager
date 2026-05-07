import { useEffect, useState, useCallback } from "react";
import { applyTheme } from "@/components/theme-toggle";

export type FontSize = "default" | "lg" | "xl";
export type Theme = "light" | "dark" | "system";
export type AuditRetention = 7 | 30 | 90 | 365 | -1; // -1 = forever

export interface AppSettings {
  theme: Theme;
  fontSize: FontSize;
  reducedMotion: boolean;
  highContrast: boolean;
  focusRingAlways: boolean;
  auditRetentionDays: AuditRetention;
}

export const defaultSettings: AppSettings = {
  theme: "system",
  fontSize: "default",
  reducedMotion: false,
  highContrast: false,
  focusRingAlways: false,
  auditRetentionDays: 90,
};

const STORAGE_KEY = "bp-settings";

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migrate legacy bp-theme if present
      const legacyTheme = localStorage.getItem("bp-theme") as Theme | null;
      if (legacyTheme) return { ...defaultSettings, theme: legacyTheme };
      return defaultSettings;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...defaultSettings, ...parsed };
  } catch {
    return defaultSettings;
  }
}

function saveSettings(s: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/**
 * Mutates the document root element to reflect the given settings.
 * Toggles `bp-*` accessibility classes and applies the theme.
 */
export function applySettings(s: AppSettings) {
  const root = document.documentElement;

  applyTheme(s.theme);

  root.classList.toggle("bp-font-lg", s.fontSize === "lg");
  root.classList.toggle("bp-font-xl", s.fontSize === "xl");
  root.classList.toggle("bp-reduced-motion", s.reducedMotion);
  root.classList.toggle("bp-high-contrast", s.highContrast);
  root.classList.toggle("bp-focus-always", s.focusRingAlways);
}

/**
 * Cold-start initializer — call once before first render.
 * Avoids a flash of un-styled accessibility classes.
 */
export function initSettings() {
  applySettings(loadSettings());
}

// ── Cross-tab/window sync ──────────────────────────────────────────────────

const listeners = new Set<(s: AppSettings) => void>();

function notifyAll(s: AppSettings) {
  listeners.forEach((l) => l(s));
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      const s = loadSettings();
      applySettings(s);
      notifyAll(s);
    }
  });
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  useEffect(() => {
    const sub = (s: AppSettings) => setSettings(s);
    listeners.add(sub);
    return () => {
      listeners.delete(sub);
    };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      applySettings(next);
      notifyAll(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    saveSettings(defaultSettings);
    applySettings(defaultSettings);
    setSettings(defaultSettings);
    notifyAll(defaultSettings);
  }, []);

  return { settings, update, reset };
}
