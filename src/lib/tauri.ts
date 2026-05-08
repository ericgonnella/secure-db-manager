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

export async function setupPocketbaseSuperuser(
  instanceId: string,
  email: string,
  password: string
): Promise<void> {
  return invoke("setup_pocketbase_superuser", { instanceId, email, password });
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

export async function exportBackup(
  backupId: string,
  destinationDir: string
): Promise<string> {
  return invoke<string>("export_backup", { backupId, destinationDir });
}

export async function openBackupFolder(backupId: string): Promise<void> {
  return invoke<void>("open_backup_folder", { backupId });
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

// ── Remote hosts ───────────────────────────────────────────────────────────

export type SslMode = "disable" | "require" | "verify-ca" | "verify-full";
export type RemoteAuthType = "password" | "ssh-tunnel";

export interface RemoteHost {
  id: string;
  name: string;
  service_type: string;
  environment: string;
  host: string;
  port: number;
  db_name: string | null;
  username: string;
  ssl_mode: SslMode;
  auth_type: RemoteAuthType;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  ssh_key_path: string | null;
  notes: string | null;
  created_at: string;
  project_id: string;
}

export interface AddRemoteHostInput {
  name: string;
  service_type: ServiceType;
  environment: string;
  host: string;
  port: number;
  db_name: string | null;
  username: string;
  password: string;
  ssl_mode?: SslMode;
  auth_type?: RemoteAuthType;
  ssh_host?: string | null;
  ssh_port?: number | null;
  ssh_user?: string | null;
  ssh_key_path?: string | null;
  notes?: string | null;
  project_id?: string;
}

export interface RemoteHostCredentials {
  host_id: string;
  host: string;
  port: number;
  username: string;
  password: string;
  db_name: string | null;
  connection_uri: string;
}

export interface RemoteConnectionResult {
  healthy: boolean;
  latency_ms: number;
  message: string;
}

export async function addRemoteHost(
  input: AddRemoteHostInput
): Promise<RemoteHost> {
  return invoke<RemoteHost>("add_remote_host", { input });
}

export async function listRemoteHosts(): Promise<RemoteHost[]> {
  return invoke<RemoteHost[]>("list_remote_hosts");
}

export async function deleteRemoteHost(hostId: string): Promise<void> {
  return invoke<void>("delete_remote_host", { hostId });
}

export async function getRemoteHostCredentials(
  hostId: string
): Promise<RemoteHostCredentials> {
  return invoke<RemoteHostCredentials>("get_remote_host_credentials", {
    hostId,
  });
}

export async function setRemoteHostPassword(
  hostId: string,
  password: string
): Promise<void> {
  return invoke<void>("set_remote_host_password", { hostId, password });
}

export async function testRemoteConnection(
  hostId: string
): Promise<RemoteConnectionResult> {
  return invoke<RemoteConnectionResult>("test_remote_connection", { hostId });
}

// ── Public exposures ───────────────────────────────────────────────────────

export type ExposureMethod = "direct" | "cloudflare" | "ngrok" | "nginx";

export interface ExposureRequest {
  instance_id: string;
  method: ExposureMethod;
  external_port?: number | null;
  hostname?: string | null;
  ngrok_token?: string | null;
}

export interface ExposureStep {
  step: number;
  title: string;
  description: string;
  /** "info" | "action" | "warning" */
  kind: string;
}

export interface ExposurePreview {
  method: string;
  steps: ExposureStep[];
  expected_endpoint: string | null;
  warnings: string[];
}

export interface Exposure {
  id: string;
  instance_id: string;
  method: string;
  status: string;
  external_endpoint: string | null;
  external_port: number | null;
  provider_id: string | null;
  pid: number | null;
  hostname: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function previewExposure(
  request: ExposureRequest
): Promise<ExposurePreview> {
  return invoke<ExposurePreview>("preview_exposure", { request });
}

export async function createExposure(
  request: ExposureRequest
): Promise<Exposure> {
  return invoke<Exposure>("create_exposure", { request });
}

export async function listExposures(): Promise<Exposure[]> {
  return invoke<Exposure[]>("list_exposures");
}

export async function removeExposure(exposureId: string): Promise<void> {
  return invoke<void>("remove_exposure", { exposureId });
}

// ── Tool management ──────────────────────────────────────────────────────

export interface ToolStatus {
  available: boolean;
  path: string | null;
  download_url: string | null;
}

export interface FirewallResult {
  success: boolean;
  message: string;
  manual_command: string | null;
}

export async function checkToolAvailable(tool: string): Promise<ToolStatus> {
  return invoke<ToolStatus>("check_tool_available", { tool });
}

export async function downloadAndInstallTool(tool: string): Promise<string> {
  return invoke<string>("download_and_install_tool", { tool });
}

export async function addFirewallRule(
  port: number,
  ruleName: string,
  exposureId?: string,
): Promise<FirewallResult> {
  return invoke<FirewallResult>("add_firewall_rule", { port, ruleName, exposureId: exposureId ?? null });
}

export async function reprovisionCloudflareExposures(
  instanceId: string,
): Promise<Exposure[]> {
  return invoke<Exposure[]>("reprovision_cloudflare_exposures", { instanceId });
}

export async function regenerateCloudflareExposure(
  exposureId: string,
): Promise<Exposure> {
  return invoke<Exposure>("regenerate_cloudflare_exposure", { exposureId });
}

// ── Web Apps ───────────────────────────────────────────────────────────────

export type WebAppMode = "dev" | "deploy";
export type WebAppStatus = "running" | "stopped" | "error";

export interface WebApp {
  id: string;
  name: string;
  container_name: string;
  config_path: string;
  port: number;
  mode: WebAppMode;
  src_path: string | null;
  build_output_dir: string;
  build_command: string | null;
  container_type: "nginx" | "nodejs";
  nodejs_start_command: string | null;
  nodejs_app_port: number;
  status: WebAppStatus;
  linked_instance_ids: string[];
  project_id: string;
  created_at: string;
}

export interface CreateWebAppInput {
  name: string;
  port: number;
  mode: WebAppMode;
  src_path: string | null;
  build_output_dir: string;
  build_command: string | null;
  container_type: "nginx" | "nodejs";
  nodejs_start_command: string | null;
  nodejs_app_port?: number;
  linked_instance_ids: string[];
  project_id?: string;
}

export interface WebAppConnectionEntry {
  instance_id: string;
  instance_name: string;
  service_type: string;
  browser_compatible: boolean;
  proxy_path: string | null;
  proxy_url: string | null;
  sdk_snippet: string | null;
  direct_uri: string | null;
  note: string | null;
}

export interface WebAppConnectionInfo {
  web_app_url: string;
  connections: WebAppConnectionEntry[];
}

export async function createWebApp(input: CreateWebAppInput): Promise<WebApp> {
  return invoke<WebApp>("create_web_app", { input });
}

export async function listWebApps(): Promise<WebApp[]> {
  return invoke<WebApp[]>("list_web_apps");
}

export async function startWebApp(webAppId: string): Promise<void> {
  return invoke("start_web_app", { id: webAppId });
}

export async function stopWebApp(webAppId: string): Promise<void> {
  return invoke("stop_web_app", { id: webAppId });
}

export async function deleteWebApp(webAppId: string): Promise<void> {
  return invoke("delete_web_app", { id: webAppId });
}

export async function deployWebApp(
  webAppId: string,
  srcPath: string,
): Promise<void> {
  return invoke("deploy_web_app", { id: webAppId, src_path: srcPath });
}

export async function getWebAppLogs(
  webAppId: string,
  tail: number,
): Promise<string> {
  return invoke<string>("get_web_app_logs", { id: webAppId, tail });
}

export async function updateWebAppLinkedInstances(
  webAppId: string,
  instanceIds: string[],
): Promise<WebApp> {
  return invoke<WebApp>("update_web_app_linked_instances", {
    id: webAppId,
    instance_ids: instanceIds,
  });
}

export async function getWebAppConnectionInfo(
  webAppId: string,
): Promise<WebAppConnectionInfo> {
  return invoke<WebAppConnectionInfo>("get_web_app_connection_info", { id: webAppId });
}

export async function rebuildWebApp(webAppId: string): Promise<string> {
  return invoke<string>("rebuild_web_app", { id: webAppId });
}

export interface WebProjectDetection {
  project_type:
    | "nextjs"
    | "vite"
    | "astro"
    | "nuxt"
    | "cra"
    | "node"
    | "node-server"
    | "plain-html"
    | "unknown";
  package_manager: "npm" | "pnpm" | "yarn" | "bun" | null;
  suggested_build_command: string | null;
  suggested_output_dir: string | null;
  compatible: boolean;
  compatibility_note: string | null;
  has_api_routes: boolean;
  has_package_json: boolean;
  suggested_container_type: "nginx" | "nodejs";
  suggested_start_command: string | null;
  suggested_app_port: number | null;
}

export async function detectWebProject(path: string): Promise<WebProjectDetection> {
  return invoke<WebProjectDetection>("detect_web_project", { path });
}
