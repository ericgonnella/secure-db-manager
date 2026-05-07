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

export type ServiceType =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "redis"
  | "mongodb"
  | "clickhouse"
  | "pocketbase";

export interface CreateInstanceInput {
  service_type: ServiceType;
  name: string;
  version: string;
  port: number;
  db_name: string | null;
  username: string | null;
  password: string;
  environment: string;
  project_id?: string;
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
  project_id: string;
}

export async function createLocalInstance(
  input: CreateInstanceInput
): Promise<LocalInstance> {
  return invoke<LocalInstance>("create_local_instance", { input });
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

// ── Credentials ────────────────────────────────────────────────────────────

export interface InstanceCredentials {
  instance_id: string;
  host: string;
  port: number;
  db_name: string | null;
  username: string;
  password: string;
  connection_uri: string;
}

export async function getInstanceCredentials(
  instanceId: string
): Promise<InstanceCredentials> {
  return invoke<InstanceCredentials>("get_instance_credentials", { instanceId });
}

export async function setInstancePassword(
  instanceId: string,
  password: string
): Promise<void> {
  return invoke("set_instance_password", { instanceId, password });
}

// ── Container logs ─────────────────────────────────────────────────────────

export async function getContainerLogs(
  instanceId: string,
  tail: number = 200
): Promise<string> {
  return invoke<string>("get_container_logs", { instanceId, tail });
}

// ── Connection test ────────────────────────────────────────────────────────

export interface ConnectionTestResult {
  healthy: boolean;
  latency_ms: number;
  message: string;
}

export async function testConnection(
  instanceId: string
): Promise<ConnectionTestResult> {
  return invoke<ConnectionTestResult>("test_connection", { instanceId });
}

// ── Backups ────────────────────────────────────────────────────────────────

export interface BackupRecord {
  id: string;
  instance_id: string;
  created_at: string;
  file_path: string;
  size_bytes: number;
  note: string | null;
}

export interface BackupInput {
  instance_id: string;
  destination_dir: string;
  note?: string | null;
}

export interface RestoreInput {
  instance_id: string;
  source_file: string;
}

export async function backupInstance(input: BackupInput): Promise<BackupRecord> {
  return invoke<BackupRecord>("backup_instance", { input });
}

export async function restoreInstance(input: RestoreInput): Promise<void> {
  return invoke<void>("restore_instance", { input });
}

export async function listBackups(
  instanceId?: string
): Promise<BackupRecord[]> {
  return invoke<BackupRecord[]>("list_backups", {
    instanceId: instanceId ?? null,
  });
}

export async function deleteBackup(backupId: string): Promise<void> {
  return invoke<void>("delete_backup", { backupId });
}

// ── Audit log ──────────────────────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: string;
  instance_id: string;
  instance_name: string;
  service_type: string;
  environment: string;
  outcome: "success" | "error";
  detail: string | null;
}

export async function listAuditLogs(): Promise<AuditEvent[]> {
  return invoke<AuditEvent[]>("list_audit_logs");
}
