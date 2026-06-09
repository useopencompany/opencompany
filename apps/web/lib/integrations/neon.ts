"use server";

import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import {
  loadIntegrationCredential,
  saveIntegrationCredential,
} from "@/lib/integrations/credential-storage";
import { sanitizeIntegrationStatusReason } from "@/lib/integrations/status";

export const NEON_INTEGRATION_PROVIDER = "neon";
export const NEON_DATABASE_RESOURCE_TYPE = "database";
const NEON_CREDENTIAL_KIND = "api_key";
const NEON_API_BASE = "https://console.neon.tech/api/v2";

type NeonProject = {
  id: string;
  name?: string;
};

type NeonBranch = {
  id: string;
  name?: string;
};

type NeonDatabase = {
  name: string;
  owner_name?: string;
};

type NeonRole = {
  name: string;
};

export async function loadNeonIntegrationState() {
  const { workspace } = await currentWorkspace();
  const [connections, resources] = await Promise.all([
    getDb()
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspace.id),
          eq(workspaceIntegrations.provider, NEON_INTEGRATION_PROVIDER),
        ),
      )
      .orderBy(workspaceIntegrations.connectionLabel, workspaceIntegrations.createdAt),
    getDb()
      .select()
      .from(workspaceIntegrationResources)
      .where(
        and(
          eq(workspaceIntegrationResources.workspaceId, workspace.id),
          eq(workspaceIntegrationResources.provider, NEON_INTEGRATION_PROVIDER),
          eq(workspaceIntegrationResources.resourceType, NEON_DATABASE_RESOURCE_TYPE),
        ),
      ),
  ]);
  const resourcesByIntegrationId = new Map<string, (typeof resources)[number][]>();
  for (const resource of resources) {
    const existing = resourcesByIntegrationId.get(resource.integrationId) ?? [];
    existing.push(resource);
    resourcesByIntegrationId.set(resource.integrationId, existing);
  }
  const activeConnections = connections.filter(
    (connection) => connection.status !== "disconnected",
  );

  return {
    neon: {
      status: neonStatus({
        connectionStatuses: activeConnections.map((connection) => connection.status),
        selectedDatabaseCount: resources.filter(
          (resource) => resource.status === "available" && resource.selectedAt !== null,
        ).length,
      }),
      connections: activeConnections.map((connection) => ({
        id: connection.id,
        projectId: connection.externalId,
        connectionLabel: connection.connectionLabel ?? connection.accountName ?? "Neon",
        accountName: connection.accountName,
        status: connection.status,
        statusReason: connection.statusReason,
        updatedAt: (connection.lastSyncedAt ?? connection.updatedAt).toISOString(),
        databases: (resourcesByIntegrationId.get(connection.id) ?? [])
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((resource) => ({
            id: resource.id,
            externalId: resource.externalId,
            name: resource.name,
            displayName: resource.displayName ?? resource.name,
            status: resource.status,
            statusReason: resource.statusReason,
            selectedAt: resource.selectedAt?.toISOString() ?? null,
            metadata: readNeonDatabaseMetadata(resource.metadata),
          })),
      })),
    },
  };
}

export async function saveNeonApiKeyAction(formData: FormData) {
  const { workspace, user } = await currentWorkspace({ requireAdmin: true });
  const apiKey = readFormString(formData.get("apiKey"));
  if (!apiKey || apiKey.length > 4096) return;

  try {
    const projects = await listProjects(apiKey);
    if (projects.length === 0) return;
    await syncNeonProjects({
      workspaceId: workspace.id,
      connectedByUserId: user.id,
      apiKey,
      projects,
    });
    revalidateIntegrationPaths();
  } catch (error) {
    console.error("Could not connect Neon", error);
  }
}

export async function refreshNeonConnectionAction(integrationId: string) {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const db = getDb();
  const [connection] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.provider, NEON_INTEGRATION_PROVIDER),
        eq(workspaceIntegrations.id, integrationId),
      ),
    )
    .limit(1);
  if (!connection) return;

  const credential = await loadIntegrationCredential({
    workspaceId: workspace.id,
    integrationId,
    provider: NEON_INTEGRATION_PROVIDER,
    kind: NEON_CREDENTIAL_KIND,
  });
  const apiKey = typeof credential?.payload.apiKey === "string" ? credential.payload.apiKey : "";
  if (!apiKey) return;

  try {
    const projects = await listProjects(apiKey);
    const project = projects.find((item) => item.id === connection.externalId);
    if (!project) throw new Error("This Neon project is no longer visible to the API key.");
    const syncInput = {
      workspaceId: workspace.id,
      apiKey,
      projects: [project],
      ...(connection.connectedByUserId ? { connectedByUserId: connection.connectedByUserId } : {}),
    };
    await syncNeonProjects(syncInput);
    revalidateIntegrationPaths();
  } catch (error) {
    await markNeonConnectionStatus({
      workspaceId: workspace.id,
      integrationId,
      status: "sync_failed",
      statusReason: error instanceof Error ? error.message : "Neon refresh failed.",
    });
    revalidateIntegrationPaths();
  }
}

export async function setNeonDatabaseSelectionAction(input: {
  resourceId: string;
  selected: boolean;
}) {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  await getDb()
    .update(workspaceIntegrationResources)
    .set({ selectedAt: input.selected ? new Date() : null, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceIntegrationResources.workspaceId, workspace.id),
        eq(workspaceIntegrationResources.provider, NEON_INTEGRATION_PROVIDER),
        eq(workspaceIntegrationResources.resourceType, NEON_DATABASE_RESOURCE_TYPE),
        eq(workspaceIntegrationResources.id, input.resourceId),
      ),
    );
  revalidateIntegrationPaths();
  return { ok: true as const };
}

export async function disconnectNeonIntegrationAction(integrationId: string) {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  await getDb()
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.provider, NEON_INTEGRATION_PROVIDER),
        eq(workspaceIntegrations.id, integrationId),
      ),
    );
  revalidateIntegrationPaths();
  return { ok: true as const, message: "Neon was disconnected from this workspace." };
}

async function syncNeonProjects(input: {
  workspaceId: string;
  connectedByUserId?: string;
  apiKey: string;
  projects: NeonProject[];
}) {
  const db = getDb();
  const now = new Date();
  for (const project of input.projects) {
    const label = project.name ?? project.id;
    const [integration] = await db
      .insert(workspaceIntegrations)
      .values({
        id: newWorkspaceIntegrationId(),
        workspaceId: input.workspaceId,
        provider: NEON_INTEGRATION_PROVIDER,
        externalId: project.id,
        connectionLabel: label,
        accountName: project.name ?? null,
        accountType: "Project",
        connectedByUserId: input.connectedByUserId ?? null,
        status: "sync_failed",
        statusReason: "Neon database sync has not completed.",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceIntegrations.workspaceId,
          workspaceIntegrations.provider,
          workspaceIntegrations.externalId,
        ],
        set: {
          connectionLabel: label,
          accountName: project.name ?? null,
          accountType: "Project",
          status: "sync_failed",
          statusReason: "Neon database sync has not completed.",
          updatedAt: now,
          ...(input.connectedByUserId ? { connectedByUserId: input.connectedByUserId } : {}),
        },
      })
      .returning({ id: workspaceIntegrations.id });
    if (!integration) throw new Error("Could not persist Neon integration.");

    await saveIntegrationCredential({
      workspaceId: input.workspaceId,
      integrationId: integration.id,
      provider: NEON_INTEGRATION_PROVIDER,
      kind: NEON_CREDENTIAL_KIND,
      payload: { apiKey: input.apiKey },
      db,
      now,
    });

    const resources = await listDatabaseResources(input.apiKey, project);
    await syncDatabaseResources({
      workspaceId: input.workspaceId,
      integrationId: integration.id,
      project,
      resources,
      now,
    });

    await db
      .update(workspaceIntegrations)
      .set({ status: "connected", statusReason: null, lastSyncedAt: now, updatedAt: now })
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, input.workspaceId),
          eq(workspaceIntegrations.provider, NEON_INTEGRATION_PROVIDER),
          eq(workspaceIntegrations.id, integration.id),
        ),
      );
  }
}

async function syncDatabaseResources(input: {
  workspaceId: string;
  integrationId: string;
  project: NeonProject;
  resources: Array<{
    externalId: string;
    name: string;
    displayName: string;
    metadata: Record<string, unknown>;
  }>;
  now: Date;
}) {
  if (input.resources.length > 0) {
    await getDb()
      .insert(workspaceIntegrationResources)
      .values(
        input.resources.map((resource) => ({
          id: newWorkspaceIntegrationResourceId(),
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          provider: NEON_INTEGRATION_PROVIDER,
          resourceType: NEON_DATABASE_RESOURCE_TYPE,
          externalId: resource.externalId,
          name: resource.name,
          displayName: resource.displayName,
          status: "available" as const,
          statusReason: null,
          lastSyncedAt: input.now,
          metadata: resource.metadata,
          selectedAt: input.now,
          updatedAt: input.now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          workspaceIntegrationResources.integrationId,
          workspaceIntegrationResources.resourceType,
          workspaceIntegrationResources.externalId,
        ],
        set: {
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          provider: NEON_INTEGRATION_PROVIDER,
          resourceType: NEON_DATABASE_RESOURCE_TYPE,
          name: sql`excluded.name`,
          displayName: sql`excluded.display_name`,
          status: "available",
          statusReason: null,
          lastSyncedAt: input.now,
          metadata: sql`excluded.metadata`,
          selectedAt: sql`COALESCE(${workspaceIntegrationResources.selectedAt}, excluded.selected_at)`,
          updatedAt: input.now,
        },
      });
  }

  const staleUpdate = {
    status: "permission_lost" as const,
    statusReason: "Database is no longer visible to the Neon API key.",
    lastSyncedAt: input.now,
    updatedAt: input.now,
  };
  const baseWhere = and(
    eq(workspaceIntegrationResources.workspaceId, input.workspaceId),
    eq(workspaceIntegrationResources.integrationId, input.integrationId),
    eq(workspaceIntegrationResources.provider, NEON_INTEGRATION_PROVIDER),
    eq(workspaceIntegrationResources.resourceType, NEON_DATABASE_RESOURCE_TYPE),
  );
  if (input.resources.length > 0) {
    await getDb()
      .update(workspaceIntegrationResources)
      .set(staleUpdate)
      .where(
        and(
          baseWhere,
          notInArray(
            workspaceIntegrationResources.externalId,
            input.resources.map((resource) => resource.externalId),
          ),
        ),
      );
  } else {
    await getDb().update(workspaceIntegrationResources).set(staleUpdate).where(baseWhere);
  }
}

async function listDatabaseResources(apiKey: string, project: NeonProject) {
  const branches = await listBranches(apiKey, project.id);
  const resources: Array<{
    externalId: string;
    name: string;
    displayName: string;
    metadata: Record<string, unknown>;
  }> = [];
  for (const branch of branches) {
    const [databases, roles] = await Promise.all([
      listDatabases(apiKey, project.id, branch.id),
      listRoles(apiKey, project.id, branch.id),
    ]);
    for (const database of databases) {
      const roleName = database.owner_name ?? roles[0]?.name ?? "neondb_owner";
      const externalId = [project.id, branch.id, database.name, roleName].join(":");
      const name = `${project.name ?? project.id}/${branch.name ?? branch.id}/${database.name}`;
      resources.push({
        externalId,
        name,
        displayName: `${name} (${roleName})`,
        metadata: {
          projectId: project.id,
          projectName: project.name,
          branchId: branch.id,
          branchName: branch.name,
          databaseName: database.name,
          roleName,
        },
      });
    }
  }
  return resources;
}

async function listProjects(apiKey: string): Promise<NeonProject[]> {
  const result = await neonApi(apiKey, "/projects?limit=100", "GET");
  return arrayValue(result, "projects")
    .map((item) => asRecord(item))
    .flatMap((item) => {
      const id = readString(item.id);
      if (!id) return [];
      const name = readString(item.name);
      return [{ id, ...(name ? { name } : {}) }];
    });
}

async function listBranches(apiKey: string, projectId: string): Promise<NeonBranch[]> {
  const result = await neonApi(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches?limit=100`,
    "GET",
  );
  return arrayValue(result, "branches")
    .map((item) => asRecord(item))
    .flatMap((item) => {
      const id = readString(item.id);
      if (!id) return [];
      const name = readString(item.name);
      return [{ id, ...(name ? { name } : {}) }];
    });
}

async function listDatabases(
  apiKey: string,
  projectId: string,
  branchId: string,
): Promise<NeonDatabase[]> {
  const result = await neonApi(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`,
    "GET",
  );
  return arrayValue(result, "databases")
    .map((item) => asRecord(item))
    .flatMap((item) => {
      const name = readString(item.name);
      if (!name) return [];
      const ownerName = readString(item.owner_name);
      return [{ name, ...(ownerName ? { owner_name: ownerName } : {}) }];
    });
}

async function listRoles(apiKey: string, projectId: string, branchId: string): Promise<NeonRole[]> {
  const result = await neonApi(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/roles`,
    "GET",
  );
  return arrayValue(result, "roles")
    .map((item) => asRecord(item))
    .flatMap((item) => {
      const name = readString(item.name);
      return name ? [{ name }] : [];
    });
}

async function neonApi(apiKey: string, path: string, method: "GET") {
  const response = await fetch(`${NEON_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  const text = await response.text();
  const parsed = text ? tryParseJson(text) : {};
  if (!response.ok) {
    throw new Error(`Neon API failed with ${response.status}: ${summarizeApiError(parsed, text)}`);
  }
  return parsed;
}

async function markNeonConnectionStatus(input: {
  workspaceId: string;
  integrationId: string;
  status: "needs_reauth" | "sync_failed";
  statusReason: string;
}) {
  await getDb()
    .update(workspaceIntegrations)
    .set({
      status: input.status,
      statusReason: sanitizeIntegrationStatusReason(input.statusReason, "Neon sync failed."),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.provider, NEON_INTEGRATION_PROVIDER),
        eq(workspaceIntegrations.id, input.integrationId),
      ),
    );
}

function neonStatus(input: {
  connectionStatuses: Array<"connected" | "needs_reauth" | "sync_failed" | "disconnected">;
  selectedDatabaseCount: number;
}) {
  if (input.connectionStatuses.length === 0) return "not_connected" as const;
  if (input.connectionStatuses.some((status) => status === "needs_reauth")) {
    return "needs_reauth" as const;
  }
  if (input.connectionStatuses.some((status) => status === "sync_failed")) {
    return "sync_failed" as const;
  }
  if (input.selectedDatabaseCount === 0) return "needs_repository_access" as const;
  return "connected" as const;
}

function readNeonDatabaseMetadata(value: Record<string, unknown>) {
  return {
    projectId: readString(value.projectId) ?? "",
    projectName: readString(value.projectName) ?? null,
    branchId: readString(value.branchId) ?? "",
    branchName: readString(value.branchName) ?? null,
    databaseName: readString(value.databaseName) ?? "",
    roleName: readString(value.roleName) ?? "",
  };
}

function readFormString(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function arrayValue(value: unknown, key: string) {
  const record = asRecord(value);
  const items = record ? record[key] : undefined;
  return Array.isArray(items) ? items : [];
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
  const record = asRecord(parsed);
  const message = readString(record.message);
  return message ?? text.slice(0, 300);
}

function newWorkspaceIntegrationId() {
  return `wint_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function newWorkspaceIntegrationResourceId() {
  return `wres_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function revalidateIntegrationPaths() {
  revalidatePath("/agents");
  revalidatePath("/settings");
  revalidatePath("/settings/integrations");
}
