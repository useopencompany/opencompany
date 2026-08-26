import type { PluginCapabilityDefinition, PluginGatewayDiscoveredTool } from "@opencompany/core";
import { and, asc, eq, lte } from "drizzle-orm";
import { pluginGatewayRegistrations, plugins } from "./product-schema";

type DbLike = any;

export type PluginGatewayRegistrationRecord = {
  id: string;
  workspaceId: string;
  pluginId: string;
  pluginName: string;
  pluginLabel: string;
  pluginDescription: string;
  connectionProvider: string;
  server: {
    name: string;
    type: "streamable-http" | "sse";
    url: string;
    headers: Record<string, string>;
  };
  capabilities: PluginCapabilityDefinition[];
  discoverySnapshot: PluginGatewayDiscoveredTool[];
  discoveredAt: Date | null;
  refreshAfter: Date;
  lastDiscoveryError: string | null;
};

export async function listActivePluginGatewayRegistrations(
  db: DbLike,
  input: { workspaceId: string; pluginName?: string; connectionProvider?: string },
): Promise<PluginGatewayRegistrationRecord[]> {
  const filters = [
    eq(pluginGatewayRegistrations.workspaceId, input.workspaceId),
    eq(plugins.status, "enabled"),
  ];
  if (input.pluginName) filters.push(eq(plugins.name, input.pluginName));
  if (input.connectionProvider) {
    filters.push(eq(pluginGatewayRegistrations.connectionProvider, input.connectionProvider));
  }

  const rows = await db
    .select({
      id: pluginGatewayRegistrations.id,
      workspaceId: pluginGatewayRegistrations.workspaceId,
      pluginId: pluginGatewayRegistrations.pluginId,
      pluginName: plugins.name,
      manifest: plugins.manifest,
      connectionProvider: pluginGatewayRegistrations.connectionProvider,
      serverName: pluginGatewayRegistrations.serverName,
      transport: pluginGatewayRegistrations.transport,
      serverUrl: pluginGatewayRegistrations.serverUrl,
      headers: pluginGatewayRegistrations.headers,
      capabilities: pluginGatewayRegistrations.capabilities,
      discoverySnapshot: pluginGatewayRegistrations.discoverySnapshot,
      discoveredAt: pluginGatewayRegistrations.discoveredAt,
      refreshAfter: pluginGatewayRegistrations.refreshAfter,
      lastDiscoveryError: pluginGatewayRegistrations.lastDiscoveryError,
    })
    .from(pluginGatewayRegistrations)
    .innerJoin(
      plugins,
      and(
        eq(plugins.id, pluginGatewayRegistrations.pluginId),
        eq(plugins.workspaceId, pluginGatewayRegistrations.workspaceId),
      ),
    )
    .where(and(...filters))
    .orderBy(asc(plugins.name), asc(pluginGatewayRegistrations.serverName));

  return rows.map((row: any) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    pluginId: row.pluginId,
    pluginName: row.pluginName,
    pluginLabel: row.manifest.description?.trim() ? row.manifest.name : row.pluginName,
    pluginDescription:
      row.manifest.description?.trim() || `${row.pluginName} tools from an installed Plugin.`,
    connectionProvider: row.connectionProvider,
    server: {
      name: row.serverName,
      type: row.transport,
      url: row.serverUrl,
      headers: row.headers,
    },
    capabilities: row.capabilities,
    discoverySnapshot: row.discoverySnapshot,
    discoveredAt: row.discoveredAt,
    refreshAfter: row.refreshAfter,
    lastDiscoveryError: row.lastDiscoveryError,
  }));
}

export async function storePluginGatewayDiscoverySnapshot(
  db: DbLike,
  input: {
    workspaceId: string;
    registrationId: string;
    snapshot: PluginGatewayDiscoveredTool[];
    discoveredAt: Date;
    refreshAfter: Date;
  },
) {
  const [updated] = await db
    .update(pluginGatewayRegistrations)
    .set({
      discoverySnapshot: input.snapshot,
      discoveredAt: input.discoveredAt,
      refreshAfter: input.refreshAfter,
      lastDiscoveryError: null,
      updatedAt: input.discoveredAt,
    })
    .where(
      and(
        eq(pluginGatewayRegistrations.id, input.registrationId),
        eq(pluginGatewayRegistrations.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: pluginGatewayRegistrations.id });
  return Boolean(updated);
}

export async function claimPluginGatewayDiscoveryRefresh(
  db: DbLike,
  input: {
    workspaceId: string;
    registrationId: string;
    staleAt: Date;
    leaseUntil: Date;
  },
) {
  const [claimed] = await db
    .update(pluginGatewayRegistrations)
    .set({ refreshAfter: input.leaseUntil, updatedAt: input.staleAt })
    .where(
      and(
        eq(pluginGatewayRegistrations.id, input.registrationId),
        eq(pluginGatewayRegistrations.workspaceId, input.workspaceId),
        lte(pluginGatewayRegistrations.refreshAfter, input.staleAt),
      ),
    )
    .returning({ id: pluginGatewayRegistrations.id });
  return Boolean(claimed);
}

export async function storePluginGatewayDiscoveryFailure(
  db: DbLike,
  input: {
    workspaceId: string;
    registrationId: string;
    error: string;
    retryAfter: Date;
    attemptedAt: Date;
  },
) {
  await db
    .update(pluginGatewayRegistrations)
    .set({
      lastDiscoveryError: input.error.slice(0, 2_000),
      refreshAfter: input.retryAfter,
      updatedAt: input.attemptedAt,
    })
    .where(
      and(
        eq(pluginGatewayRegistrations.id, input.registrationId),
        eq(pluginGatewayRegistrations.workspaceId, input.workspaceId),
      ),
    );
}

export async function isPluginGatewayRegistrationActive(
  db: DbLike,
  input: { workspaceId: string; registrationId: string },
) {
  const [row] = await db
    .select({ id: pluginGatewayRegistrations.id })
    .from(pluginGatewayRegistrations)
    .innerJoin(
      plugins,
      and(
        eq(plugins.id, pluginGatewayRegistrations.pluginId),
        eq(plugins.workspaceId, pluginGatewayRegistrations.workspaceId),
      ),
    )
    .where(
      and(
        eq(pluginGatewayRegistrations.id, input.registrationId),
        eq(pluginGatewayRegistrations.workspaceId, input.workspaceId),
        eq(plugins.status, "enabled"),
      ),
    )
    .limit(1);
  return Boolean(row);
}
