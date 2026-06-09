import { classifyNeonSql, hasMultipleSqlStatements } from "@opencompany/agent-runtime";
import { buildAad, decryptJson, ENCRYPTION_ALGORITHM } from "@opencompany/crypto";
import { createPooledDb } from "@opencompany/db/pool";
import {
  type WorkspaceIntegrationCredentialEncryptedPayload,
  workspaceIntegrationCredentials,
  workspaceIntegrationResources,
  workspaceIntegrations,
} from "@opencompany/db/schema";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { getDb } from "./db";
import type { HostedToolResult } from "./hosted-tools";

export type NeonToolContext = {
  workspaceId: string;
  encryptionKey: Buffer;
};

const NEON_PROVIDER = "neon";
const NEON_DATABASE_RESOURCE_TYPE = "database";
const NEON_CREDENTIAL_KIND = "api_key";
const ENCRYPTION_KEY_VERSION = 1;
const NEON_API_BASE = "https://console.neon.tech/api/v2";
const QUERY_ROW_LIMIT_DEFAULT = 100;
const QUERY_ROW_LIMIT_MAX = 500;
const QUERY_TIMEOUT_MS = 15_000;

type NeonDatabaseMetadata = {
  projectId?: string;
  projectName?: string;
  branchId?: string;
  branchName?: string;
  databaseName?: string;
  roleName?: string;
};

type NeonDatabaseResource = {
  id: string;
  integrationId: string;
  externalId: string;
  name: string;
  displayName: string | null;
  metadata: NeonDatabaseMetadata;
};

export function isNeonHostedTool(name: string): boolean {
  return (
    name === "neon_list_databases" ||
    name === "neon_describe_schema" ||
    name === "neon_run_sql" ||
    name === "neon_explain_sql" ||
    name === "neon_create_branch" ||
    name === "neon_delete_branch" ||
    name === "neon_reset_branch"
  );
}

export async function executeNeonHostedTool(input: {
  name: string;
  args: unknown;
  context: NeonToolContext | undefined;
  signal: AbortSignal;
}): Promise<HostedToolResult> {
  const { context } = input;
  if (!context) {
    throw new Error("Neon tools require a workspace context and are not available in this run.");
  }

  switch (input.name) {
    case "neon_list_databases":
      return { output: await listDatabases(context) };
    case "neon_describe_schema":
      return { output: await describeSchema(context, asRecord(input.args), input.signal) };
    case "neon_run_sql":
      return { output: await runSql(context, asRecord(input.args), input.signal) };
    case "neon_explain_sql":
      return { output: await explainSql(context, asRecord(input.args), input.signal) };
    case "neon_create_branch":
      return { output: await createBranch(context, asRecord(input.args), input.signal) };
    case "neon_delete_branch":
      return { output: await deleteBranch(context, asRecord(input.args), input.signal) };
    case "neon_reset_branch":
      return { output: await resetBranch(context, asRecord(input.args), input.signal) };
    default:
      throw new Error(`Unknown Neon tool: ${input.name}`);
  }
}

async function listDatabases(context: NeonToolContext) {
  const resources = await loadSelectedDatabaseResources(context.workspaceId);
  return {
    databases: resources.map((resource) => formatDatabaseResource(resource)),
  };
}

async function describeSchema(
  context: NeonToolContext,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const resource = await requireDatabaseResource(context.workspaceId, readString(args.databaseId));
  const schemaFilter = readOptionalIdentifier(args.schema, "schema");
  return withDatabaseConnection(context, resource, signal, async (pool) => {
    const schemaRows = await pool.query(
      `
        SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND ($1::text IS NULL OR table_schema = $1)
        ORDER BY table_schema, table_name, ordinal_position
      `,
      [schemaFilter],
    );
    const keyRows = await pool.query(
      `
        SELECT tc.table_schema, tc.table_name, tc.constraint_type, kcu.column_name,
               ccu.table_schema AS foreign_table_schema,
               ccu.table_name AS foreign_table_name,
               ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
         AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND ($1::text IS NULL OR tc.table_schema = $1)
          AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
        ORDER BY tc.table_schema, tc.table_name, tc.constraint_type, kcu.ordinal_position
      `,
      [schemaFilter],
    );
    const indexRows = await pool.query(
      `
        SELECT schemaname, tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          AND ($1::text IS NULL OR schemaname = $1)
        ORDER BY schemaname, tablename, indexname
      `,
      [schemaFilter],
    );
    return {
      database: formatDatabaseResource(resource),
      columns: schemaRows.rows,
      constraints: keyRows.rows,
      indexes: indexRows.rows,
    };
  });
}

async function runSql(
  context: NeonToolContext,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const resource = await requireDatabaseResource(context.workspaceId, readString(args.databaseId));
  const sql = readSql(args.sql);
  assertSingleStatement(sql);
  const group = classifyNeonSql(sql);
  const limit = clampLimit(args.limit);

  return withDatabaseConnection(context, resource, signal, async (pool) => {
    const result = await pool.query(sql);
    return {
      database: formatDatabaseResource(resource),
      statementClass: group,
      command: result.command,
      rowCount: result.rowCount,
      fields: result.fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID })),
      rows: result.rows.slice(0, limit),
      truncated: result.rows.length > limit,
    };
  });
}

async function explainSql(
  context: NeonToolContext,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const resource = await requireDatabaseResource(context.workspaceId, readString(args.databaseId));
  const sql = readSql(args.sql);
  assertSingleStatement(sql);
  if (/^\s*explain\b/i.test(sql) || /\banalyze\b/i.test(sql)) {
    throw new Error(
      "Pass SQL without EXPLAIN. EXPLAIN ANALYZE is blocked because it executes SQL.",
    );
  }
  return withDatabaseConnection(context, resource, signal, async (pool) => {
    const result = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    return {
      database: formatDatabaseResource(resource),
      plan: result.rows[0]?.["QUERY PLAN"] ?? result.rows,
    };
  });
}

async function createBranch(
  context: NeonToolContext,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const projectId = await requireConnectedProject(context.workspaceId, readString(args.projectId));
  const apiKey = await loadNeonApiKey(context, projectId);
  const name = requireNonEmptyString(args.name, "name");
  const parentBranchId = readString(args.parentBranchId);
  const body = {
    branch: {
      name,
      ...(parentBranchId ? { parent_id: parentBranchId } : {}),
    },
  };
  return neonApi(apiKey, `/projects/${encodeURIComponent(projectId)}/branches`, {
    method: "POST",
    body,
    signal,
  });
}

async function deleteBranch(
  context: NeonToolContext,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const projectId = await requireConnectedProject(context.workspaceId, readString(args.projectId));
  const apiKey = await loadNeonApiKey(context, projectId);
  const branchId = requireNonEmptyString(args.branchId, "branchId");
  return neonApi(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
    {
      method: "DELETE",
      signal,
    },
  );
}

async function resetBranch(
  context: NeonToolContext,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const projectId = await requireConnectedProject(context.workspaceId, readString(args.projectId));
  const apiKey = await loadNeonApiKey(context, projectId);
  const branchId = requireNonEmptyString(args.branchId, "branchId");
  return neonApi(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/reset_from_parent`,
    { method: "POST", signal },
  );
}

async function withDatabaseConnection<T>(
  context: NeonToolContext,
  resource: NeonDatabaseResource,
  signal: AbortSignal,
  run: (pool: ReturnType<typeof createPooledDb>["pool"]) => Promise<T>,
) {
  const apiKey = await loadNeonApiKey(context, resource.metadata.projectId);
  const connectionUri = await getConnectionUri(apiKey, resource, signal);
  const handle = createPooledDb(connectionUri, {
    max: 1,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 10_000,
    statementTimeoutMillis: QUERY_TIMEOUT_MS,
  });
  try {
    return await run(handle.pool);
  } finally {
    await handle.close();
  }
}

async function getConnectionUri(
  apiKey: string,
  resource: NeonDatabaseResource,
  signal: AbortSignal,
) {
  const { projectId, branchId, databaseName, roleName } = requiredDatabaseMetadata(resource);
  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: databaseName,
    role_name: roleName,
    pooled: "true",
  });
  const result = await neonApi(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/connection_uri?${params}`,
    {
      method: "GET",
      signal,
    },
  );
  const uri = readString((result as Record<string, unknown>).uri);
  if (!uri) throw new Error("Neon did not return a connection URI.");
  return uri;
}

async function loadSelectedDatabaseResources(workspaceId: string): Promise<NeonDatabaseResource[]> {
  const rows = await getDb()
    .select({
      id: workspaceIntegrationResources.id,
      integrationId: workspaceIntegrationResources.integrationId,
      externalId: workspaceIntegrationResources.externalId,
      name: workspaceIntegrationResources.name,
      displayName: workspaceIntegrationResources.displayName,
      metadata: workspaceIntegrationResources.metadata,
    })
    .from(workspaceIntegrationResources)
    .where(
      and(
        eq(workspaceIntegrationResources.workspaceId, workspaceId),
        eq(workspaceIntegrationResources.provider, NEON_PROVIDER),
        eq(workspaceIntegrationResources.resourceType, NEON_DATABASE_RESOURCE_TYPE),
        eq(workspaceIntegrationResources.status, "available"),
        isNotNull(workspaceIntegrationResources.selectedAt),
      ),
    );
  return rows.map((row) => ({
    ...row,
    metadata: parseDatabaseMetadata(row.metadata),
  }));
}

async function requireDatabaseResource(workspaceId: string, databaseId: string | undefined) {
  if (!databaseId) throw new Error("databaseId is required.");
  const resources = await loadSelectedDatabaseResources(workspaceId);
  const match = resources.find((resource) => resource.id === databaseId);
  if (!match) {
    throw new Error(
      "That Neon database is not selected for this workspace, or it is no longer available.",
    );
  }
  requiredDatabaseMetadata(match);
  return match;
}

async function requireConnectedProject(workspaceId: string, projectId: string | undefined) {
  if (!projectId) throw new Error("projectId is required.");
  const resources = await loadSelectedDatabaseResources(workspaceId);
  if (!resources.some((resource) => resource.metadata.projectId === projectId)) {
    throw new Error("That Neon project is not selected for this workspace.");
  }
  return projectId;
}

async function loadNeonApiKey(context: NeonToolContext, projectId: string | undefined) {
  const rows = await getDb()
    .select({
      integrationId: workspaceIntegrations.id,
      externalId: workspaceIntegrations.externalId,
      encryptedPayload: workspaceIntegrationCredentials.encryptedPayload,
      encryptionKeyVersion: workspaceIntegrationCredentials.encryptionKeyVersion,
    })
    .from(workspaceIntegrations)
    .innerJoin(
      workspaceIntegrationCredentials,
      and(
        eq(workspaceIntegrationCredentials.workspaceId, workspaceIntegrations.workspaceId),
        eq(workspaceIntegrationCredentials.integrationId, workspaceIntegrations.id),
        eq(workspaceIntegrationCredentials.provider, workspaceIntegrations.provider),
        eq(workspaceIntegrationCredentials.kind, NEON_CREDENTIAL_KIND),
      ),
    )
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, context.workspaceId),
        eq(workspaceIntegrations.provider, NEON_PROVIDER),
        ne(workspaceIntegrations.status, "disconnected"),
      ),
    );
  const row = rows.find((item) => !projectId || item.externalId === projectId) ?? rows[0];
  if (!row) {
    throw new Error("No Neon API key is connected for this workspace.");
  }
  const payload = decryptCredential(
    row.encryptedPayload,
    context,
    row.integrationId,
    row.encryptionKeyVersion,
  );
  const apiKey = readString(payload.apiKey);
  if (!apiKey) throw new Error("Stored Neon credentials are missing an API key.");
  return apiKey;
}

function decryptCredential(
  encryptedPayload: WorkspaceIntegrationCredentialEncryptedPayload,
  context: NeonToolContext,
  integrationId: string,
  keyVersion: number,
) {
  if (keyVersion !== ENCRYPTION_KEY_VERSION) {
    throw new Error(`Unsupported Neon credential encryption key version ${keyVersion}.`);
  }
  if (encryptedPayload.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported Neon credential encryption algorithm ${encryptedPayload.algorithm}.`,
    );
  }
  try {
    return decryptJson(encryptedPayload, {
      key: context.encryptionKey,
      aad: buildAad({
        workspaceId: context.workspaceId,
        integrationId,
        provider: NEON_PROVIDER,
        kind: NEON_CREDENTIAL_KIND,
        keyVersion,
      }),
    });
  } catch {
    throw new Error("Neon credential could not be decrypted.");
  }
}

async function neonApi(
  apiKey: string,
  path: string,
  options: { method: "GET" | "POST" | "DELETE"; body?: unknown; signal: AbortSignal },
) {
  const response = await fetch(`${NEON_API_BASE}${path}`, {
    method: options.method,
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const parsed = text ? tryParseJson(text) : {};
  if (!response.ok) {
    throw new Error(
      `Neon API ${options.method} ${path} failed with ${response.status}: ${summarizeApiError(parsed, text)}`,
    );
  }
  return parsed;
}

function formatDatabaseResource(resource: NeonDatabaseResource) {
  const metadata = requiredDatabaseMetadata(resource);
  return {
    id: resource.id,
    displayName: resource.displayName ?? resource.name,
    projectId: metadata.projectId,
    projectName: resource.metadata.projectName,
    branchId: metadata.branchId,
    branchName: resource.metadata.branchName,
    databaseName: metadata.databaseName,
    roleName: metadata.roleName,
  };
}

function requiredDatabaseMetadata(resource: NeonDatabaseResource) {
  const projectId = readString(resource.metadata.projectId);
  const branchId = readString(resource.metadata.branchId);
  const databaseName = readString(resource.metadata.databaseName);
  const roleName = readString(resource.metadata.roleName);
  if (!projectId || !branchId || !databaseName || !roleName) {
    throw new Error(`Neon database resource ${resource.id} is missing required metadata.`);
  }
  return { projectId, branchId, databaseName, roleName };
}

function parseDatabaseMetadata(value: Record<string, unknown>): NeonDatabaseMetadata {
  const projectId = readString(value.projectId);
  const projectName = readString(value.projectName);
  const branchId = readString(value.branchId);
  const branchName = readString(value.branchName);
  const databaseName = readString(value.databaseName);
  const roleName = readString(value.roleName);
  return {
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(branchId ? { branchId } : {}),
    ...(branchName ? { branchName } : {}),
    ...(databaseName ? { databaseName } : {}),
    ...(roleName ? { roleName } : {}),
  };
}

function assertSingleStatement(sql: string) {
  if (hasMultipleSqlStatements(sql)) {
    throw new Error("Neon SQL tools accept exactly one SQL statement.");
  }
}

function readSql(value: unknown) {
  const sql = requireNonEmptyString(value, "sql");
  if (sql.length > 50_000) throw new Error("SQL statement is too long.");
  return sql;
}

function clampLimit(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return QUERY_ROW_LIMIT_DEFAULT;
  return Math.max(1, Math.min(Math.trunc(value), QUERY_ROW_LIMIT_MAX));
}

function readOptionalIdentifier(value: unknown, name: string) {
  if (value === undefined || value === null || value === "") return null;
  const text = requireNonEmptyString(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_$-]*$/.test(text)) {
    throw new Error(`${name} must be a simple identifier.`);
  }
  return text;
}

function requireNonEmptyString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tryParseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function summarizeApiError(parsed: unknown, text: string) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const message = (parsed as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return text.slice(0, 300);
}
