import { Server } from "lucide-react";

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
      </div>
      <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card py-16 text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Server className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">Coming soon</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This section is part of a future MVP phase.
        </p>
      </div>
    </div>
  );
}
