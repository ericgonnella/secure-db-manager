import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "success" | "warning" | "error" | "muted";
}

const variantClasses: Record<string, string> = {
  default: "bg-primary/10 text-primary",
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  error: "bg-red-500/10 text-red-600 dark:text-red-400",
  muted: "bg-muted text-muted-foreground",
};

export function StatusBadge({
  variant = "default",
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          variant === "success" && "bg-emerald-500",
          variant === "warning" && "bg-amber-500",
          variant === "error" && "bg-red-500",
          variant === "muted" && "bg-muted-foreground/50",
          variant === "default" && "bg-primary"
        )}
      />
      {children}
    </span>
  );
}
