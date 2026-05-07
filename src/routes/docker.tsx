import { DockerStatusCard } from "@/features/docker/docker-status-card";

export function DockerPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Docker Status
        </h1>
        <p className="text-sm text-muted-foreground">
          Detailed information about your Docker installation, daemon, and setup
          guidance.
        </p>
      </header>

      <DockerStatusCard />
    </div>
  );
}
