import { useState, useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const resolved = theme === "system" ? getSystemTheme() : theme;
  root.classList.toggle("dark", resolved === "dark");
  localStorage.setItem("sdm-theme", theme);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem("sdm-theme") as Theme | null;
    return stored ?? "system";
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyTheme(t);
  };

  return { theme, setTheme };
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  const toggle = () => {
    const resolved = theme === "system" ? getSystemTheme() : theme;
    setTheme(resolved === "dark" ? "light" : "dark");
  };

  const isDark =
    theme === "dark" || (theme === "system" && getSystemTheme() === "dark");

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className
      )}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
