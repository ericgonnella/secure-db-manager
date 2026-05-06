import { invoke } from "@tauri-apps/api/core";

export type DockerMode = "native" | "wsl2" | "none";

export interface SetupStep {
  text: string;
  code: string | null;
}

export interface DockerStatus {
  cli_available: boolean;
  cli_version: string | null;
  daemon_running: boolean;
  daemon_error: string | null;
  mode: DockerMode;
  setup_steps: SetupStep[];
}

export async function detectDocker(): Promise<DockerStatus> {
  return invoke<DockerStatus>("detect_docker");
}

// ── Local instances ────────────────────────────────────────────────────────

export interface CreatePostgresInput {
  name: string;
  version: string;
  port: number;
  db_name: string;
  username: string;
  password: string;
  environment: string;
}

export interface LocalInstance {
  id: string;
  name: string;
  service_type: string;
  environment: string;
  container_name: string;
  volume_name: string;
  host: string;
  port: number;
  db_name: string | null;
  username: string;
  status: string;
  created_at: string;
}

export async function createLocalPostgres(
  input: CreatePostgresInput
): Promise<LocalInstance> {
  return invoke<LocalInstance>("create_local_postgres", { input });
}

export async function listLocalInstances(): Promise<LocalInstance[]> {
  return invoke<LocalInstance[]>("list_local_instances");
}

export async function startLocalInstance(instanceId: string): Promise<void> {
  return invoke("start_local_instance", { instanceId });
}

export async function stopLocalInstance(instanceId: string): Promise<void> {
  return invoke("stop_local_instance", { instanceId });
}

export async function deleteLocalInstance(
  instanceId: string,
  deleteVolume: boolean
): Promise<void> {
  return invoke("delete_local_instance", { instanceId, deleteVolume });
}
