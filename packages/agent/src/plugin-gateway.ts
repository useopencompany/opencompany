import type { PluginGatewayLifecycle } from "@opencompany/core";
import { getDb } from "@opencompany/db/client";
import {
  claimPluginGatewayDiscoveryRefresh,
  isPluginGatewayRegistrationActive,
  listActivePluginGatewayRegistrations,
  type PluginGatewayRegistrationRecord,
  storePluginGatewayDiscoveryFailure,
  storePluginGatewayDiscoverySnapshot,
} from "@opencompany/db/plugin-gateway-repository";
import { createLogger } from "@opencompany/observability";
import {
  discoverRemoteMcpSnapshot,
  type RemoteMcpGatewayDependencies,
  type RemoteMcpGatewayRegistration,
} from "./actions/remote-mcp";
import type { ActionProviderId } from "./actions/types";
import {
  getLatitudeIntegrationState,
  LATITUDE_MCP_ENDPOINT_URL,
  loadLatitudeMcpWorkerConnection,
} from "./integrations/latitude-mcp";
import {
  getLinearIntegrationState,
  LINEAR_MCP_ENDPOINT_URL,
  loadLinearMcpWorkerConnection,
} from "./integrations/linear-mcp";
import {
  getNeonIntegrationState,
  loadNeonMcpWorkerConnection,
  NEON_MCP_ENDPOINT_URL,
} from "./integrations/neon-mcp";
import {
  getPostHogIntegrationState,
  loadPostHogMcpWorkerConnection,
  POSTHOG_MCP_ENDPOINT_URL,
} from "./integrations/posthog-mcp";

const DISCOVERY_TTL_MS = 60 * 60 * 1_000;
const DISCOVERY_RETRY_MS = 5 * 60 * 1_000;

type DbLike = any;
type Identity = { userWorkosId: string; workspaceId: string };

const logger = createLogger({ service: "opencompany-agent", runtime: "plugin-gateway" });

const providerBindings = {
  linear: {
    endpointUrl: LINEAR_MCP_ENDPOINT_URL,
    getState: getLinearIntegrationState,
    loadConnection: loadLinearMcpWorkerConnection,
  },
  posthog: {
    endpointUrl: POSTHOG_MCP_ENDPOINT_URL,
    getState: getPostHogIntegrationState,
    loadConnection: loadPostHogMcpWorkerConnection,
  },
  neon: {
    endpointUrl: NEON_MCP_ENDPOINT_URL,
    getState: getNeonIntegrationState,
    loadConnection: loadNeonMcpWorkerConnection,
  },
  latitude: {
    endpointUrl: LATITUDE_MCP_ENDPOINT_URL,
    getState: getLatitudeIntegrationState,
    loadConnection: loadLatitudeMcpWorkerConnection,
  },
} as const;

type BoundProvider = keyof typeof providerBindings;

export function createPluginGatewayLifecycle(input: { db: DbLike }): PluginGatewayLifecycle {
  return {
    refresh: async ({ actor, pluginName }) => {
      await refreshPluginGatewayRegistrations({
        db: input.db,
        identity: { userWorkosId: actor.userId, workspaceId: actor.workspaceId },
        pluginName,
        force: true,
      });
    },
  };
}

export async function resolvePluginGatewayRegistrations(
  identity: Identity,
  options: {
    db?: DbLike;
    now?: Date;
    discoveryDependencies?: Partial<RemoteMcpGatewayDependencies>;
  } = {},
): Promise<RemoteMcpGatewayRegistration[]> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const records = await listActivePluginGatewayRegistrations(db, {
    workspaceId: identity.workspaceId,
  });
  const refreshed = await Promise.all(
    records.map((record) =>
      record.refreshAfter <= now
        ? refreshRegistration({
            db,
            identity,
            record,
            now,
            force: false,
            ...(options.discoveryDependencies
              ? { discoveryDependencies: options.discoveryDependencies }
              : {}),
          })
        : record,
    ),
  );
  return refreshed.flatMap((record) => {
    const registration = bindRegistration(db, identity, record);
    return registration ? [registration] : [];
  });
}

export async function refreshPluginGatewayRegistrations(input: {
  db?: DbLike;
  identity: Identity;
  pluginName?: string;
  connectionProvider?: string;
  force?: boolean;
  now?: Date;
  discoveryDependencies?: Partial<RemoteMcpGatewayDependencies>;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const records = await listActivePluginGatewayRegistrations(db, {
    workspaceId: input.identity.workspaceId,
    ...(input.pluginName ? { pluginName: input.pluginName } : {}),
    ...(input.connectionProvider ? { connectionProvider: input.connectionProvider } : {}),
  });
  await Promise.all(
    records.map((record) =>
      refreshRegistration({
        db,
        identity: input.identity,
        record,
        now,
        force: input.force ?? true,
        ...(input.discoveryDependencies
          ? { discoveryDependencies: input.discoveryDependencies }
          : {}),
      }),
    ),
  );
}

export async function refreshPluginGatewayRegistrationsForWorkspaces(input: {
  db?: DbLike;
  userWorkosId: string;
  workspaceIds: readonly string[];
  connectionProvider: string;
}) {
  await Promise.all(
    [...new Set(input.workspaceIds)].map((workspaceId) =>
      refreshPluginGatewayRegistrations({
        ...(input.db ? { db: input.db } : {}),
        identity: { userWorkosId: input.userWorkosId, workspaceId },
        connectionProvider: input.connectionProvider,
        force: true,
      }),
    ),
  );
}

async function refreshRegistration(input: {
  db: DbLike;
  identity: Identity;
  record: PluginGatewayRegistrationRecord;
  now: Date;
  force: boolean;
  discoveryDependencies?: Partial<RemoteMcpGatewayDependencies>;
}): Promise<PluginGatewayRegistrationRecord> {
  const registration = bindRegistration(input.db, input.identity, input.record);
  if (!registration) return input.record;

  if (!input.force) {
    const claimed = await claimPluginGatewayDiscoveryRefresh(input.db, {
      workspaceId: input.identity.workspaceId,
      registrationId: input.record.id,
      staleAt: input.now,
      leaseUntil: new Date(input.now.getTime() + DISCOVERY_RETRY_MS),
    });
    if (!claimed) return input.record;
  }

  try {
    const snapshot = await discoverRemoteMcpSnapshot(
      input.identity,
      registration,
      input.discoveryDependencies,
    );
    if (!snapshot) {
      await storePluginGatewayDiscoveryFailure(input.db, {
        workspaceId: input.identity.workspaceId,
        registrationId: input.record.id,
        error: "No usable provider connection was available for MCP discovery.",
        retryAfter: new Date(input.now.getTime() + DISCOVERY_RETRY_MS),
        attemptedAt: input.now,
      });
      return input.record;
    }
    const refreshAfter = new Date(input.now.getTime() + DISCOVERY_TTL_MS);
    await storePluginGatewayDiscoverySnapshot(input.db, {
      workspaceId: input.identity.workspaceId,
      registrationId: input.record.id,
      snapshot,
      discoveredAt: input.now,
      refreshAfter,
    });
    return {
      ...input.record,
      discoverySnapshot: snapshot,
      discoveredAt: input.now,
      refreshAfter,
      lastDiscoveryError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await storePluginGatewayDiscoveryFailure(input.db, {
      workspaceId: input.identity.workspaceId,
      registrationId: input.record.id,
      error: message,
      retryAfter: new Date(input.now.getTime() + DISCOVERY_RETRY_MS),
      attemptedAt: input.now,
    });
    logger.warn("Plugin MCP discovery refresh failed", {
      event: "opencompany.plugin_mcp_discovery_failed",
      workspace_id: input.identity.workspaceId,
      plugin_name: input.record.pluginName,
      server_name: input.record.server.name,
      error_message: message,
    });
    return input.record;
  }
}

function bindRegistration(
  db: DbLike,
  identity: Identity,
  record: PluginGatewayRegistrationRecord,
): RemoteMcpGatewayRegistration | null {
  if (!isBoundProvider(record.connectionProvider)) return null;
  const binding = providerBindings[record.connectionProvider];
  // OAuth tokens are audience-bound to the provider endpoint. A package that merely reuses a
  // provider name must never redirect those credentials to another remote server.
  if (record.server.url !== binding.endpointUrl) return null;
  return {
    source: `plugin:${record.pluginName}:${record.server.name}`,
    connectionProvider: record.connectionProvider as ActionProviderId,
    label: displayName(record.pluginName),
    description: record.pluginDescription,
    server: record.server,
    capabilities: record.capabilities,
    discoverySnapshot: record.discoverySnapshot,
    getState: binding.getState,
    loadConnection: binding.loadConnection,
    isEnabled: () =>
      isPluginGatewayRegistrationActive(db, {
        workspaceId: identity.workspaceId,
        registrationId: record.id,
      }),
  };
}

function isBoundProvider(value: string): value is BoundProvider {
  return Object.hasOwn(providerBindings, value);
}

function displayName(value: string) {
  return value
    .split(/[.-]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
