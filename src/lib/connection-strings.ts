import type { Exposure, InstanceCredentials, LocalInstance } from "./tauri";

export interface ConnectionString {
  label: string;
  value: string;
  description?: string;
}

export interface ConnectionStringSet {
  internal: ConnectionString[];
  external: ConnectionString[];
}

interface Endpoint {
  host: string;
  port: number;
}

function parseEndpoint(raw: string | null | undefined): Endpoint | null {
  if (!raw) return null;
  // Strip scheme if present
  const stripped = raw.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, "");
  // Drop any trailing path/query
  const hostPort = stripped.split(/[/?#]/)[0];
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon === -1) return null;
  const host = hostPort.slice(0, lastColon);
  const port = Number.parseInt(hostPort.slice(lastColon + 1), 10);
  if (!host || Number.isNaN(port)) return null;
  return { host, port };
}

function buildForEndpoint(
  serviceType: string,
  endpoint: Endpoint,
  creds: InstanceCredentials,
  instance: LocalInstance
): ConnectionString[] {
  const { host, port } = endpoint;
  const user = encodeURIComponent(creds.username);
  const pass = encodeURIComponent(creds.password);
  const dbRaw = creds.db_name ?? instance.db_name ?? "";
  const db = encodeURIComponent(dbRaw);

  switch (serviceType) {
    case "postgres":
      return [
        {
          label: "URI",
          value: `postgresql://${user}:${pass}@${host}:${port}/${db}`,
          description: "Standard postgres:// connection URI",
        },
        {
          label: "psql",
          value: `psql "postgresql://${user}:${pass}@${host}:${port}/${db}"`,
          description: "PostgreSQL CLI",
        },
        {
          label: "JDBC",
          value: `jdbc:postgresql://${host}:${port}/${dbRaw}?user=${user}&password=${pass}`,
        },
      ];

    case "mysql":
    case "mariadb":
      return [
        {
          label: "URI",
          value: `mysql://${user}:${pass}@${host}:${port}/${db}`,
        },
        {
          label: "mysql CLI",
          value: `mysql -h ${host} -P ${port} -u ${creds.username} -p'${creds.password}'${dbRaw ? ` ${dbRaw}` : ""}`,
        },
        {
          label: "JDBC",
          value: `jdbc:mysql://${host}:${port}/${dbRaw}?user=${user}&password=${pass}`,
        },
      ];

    case "redis":
      return [
        {
          label: "URI",
          value: `redis://default:${pass}@${host}:${port}`,
        },
        {
          label: "redis-cli",
          value: `redis-cli -h ${host} -p ${port} -a '${creds.password}'`,
        },
      ];

    case "mongodb":
      return [
        {
          label: "URI",
          value: `mongodb://${user}:${pass}@${host}:${port}/${db}?authSource=admin`,
        },
        {
          label: "mongosh",
          value: `mongosh "mongodb://${user}:${pass}@${host}:${port}/${db}?authSource=admin"`,
        },
      ];

    case "clickhouse":
      return [
        {
          label: "URI",
          value: `clickhouse://${user}:${pass}@${host}:${port}/${db}`,
        },
        {
          label: "HTTP",
          value: `http://${host}:${port}/?user=${user}&password=${pass}${dbRaw ? `&database=${db}` : ""}`,
        },
        {
          label: "clickhouse-client",
          value: `clickhouse-client --host=${host} --port=${port} --user=${creds.username} --password='${creds.password}'${dbRaw ? ` --database=${dbRaw}` : ""}`,
        },
      ];

    case "pocketbase":
      return [
        {
          label: "Admin URL",
          value: `http://${host}:${port}/_/`,
          description: "PocketBase admin dashboard",
        },
        {
          label: "API Base",
          value: `http://${host}:${port}/api/`,
        },
      ];

    default:
      return [
        {
          label: "Host",
          value: `${host}:${port}`,
        },
      ];
  }
}

export function buildConnectionStrings(
  instance: LocalInstance,
  creds: InstanceCredentials,
  exposure?: Exposure | null
): ConnectionStringSet {
  const internalEndpoint: Endpoint = {
    host: creds.host || instance.host || "127.0.0.1",
    port: creds.port || instance.port,
  };

  const internal = buildForEndpoint(
    instance.service_type,
    internalEndpoint,
    creds,
    instance
  );

  let external: ConnectionString[] = [];
  if (exposure && exposure.status === "active" && exposure.external_endpoint) {
    const parsed = parseEndpoint(exposure.external_endpoint);
    if (parsed) {
      external = buildForEndpoint(
        instance.service_type,
        parsed,
        creds,
        instance
      );
    }
  }

  return { internal, external };
}
