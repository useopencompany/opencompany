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
import {
  ATTIO_MCP_ENDPOINT_URL,
  getAttioMcpIntegrationState,
  loadAttioMcpWorkerConnection,
} from "./integrations/attio-mcp";
import {
  BETTERSTACK_MCP_ENDPOINT_URL,
  getBetterStackIntegrationState,
  loadBetterStackMcpWorkerConnection,
} from "./integrations/betterstack-mcp";
import {
  FATHOM_MCP_ENDPOINT_URL,
  getFathomMcpIntegrationState,
  loadFathomMcpWorkerConnection,
} from "./integrations/fathom-mcp";
import {
  GITHUB_USER_MCP_ENDPOINT_URL,
  getGitHubUserMcpIntegrationState,
  loadGitHubUserMcpWorkerConnection,
} from "./integrations/github-user-mcp";
import {
  GMAIL_MCP_ENDPOINT_URL,
  getGmailMcpIntegrationState,
  gmailMcpRuntimeEndpointUrl,
  loadGmailMcpWorkerConnection,
} from "./integrations/gmail-mcp";
import {
  GOOGLE_CALENDAR_MCP_ENDPOINT_URL,
  getGoogleCalendarMcpIntegrationState,
  googleCalendarMcpRuntimeEndpointUrl,
  loadGoogleCalendarMcpWorkerConnection,
} from "./integrations/google-calendar-mcp";
import {
  GOOGLE_DRIVE_MCP_ENDPOINT_URL,
  getGoogleDriveMcpIntegrationState,
  googleDriveMcpRuntimeEndpointUrl,
  loadGoogleDriveMcpWorkerConnection,
} from "./integrations/google-drive-mcp";
import {
  GRANOLA_MCP_ENDPOINT_URL,
  getGranolaMcpIntegrationState,
  loadGranolaMcpWorkerConnection,
} from "./integrations/granola-mcp";
import {
  getHubSpotMcpIntegrationState,
  HUBSPOT_MCP_ENDPOINT_URL,
  loadHubSpotMcpWorkerConnection,
} from "./integrations/hubspot-mcp";
import {
  getJamieMcpIntegrationState,
  JAMIE_MCP_ENDPOINT_URL,
  loadJamieMcpWorkerConnection,
} from "./integrations/jamie-mcp";
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
import {
  getRenderIntegrationState,
  loadRenderMcpWorkerConnection,
  RENDER_MCP_ENDPOINT_URL,
} from "./integrations/render-mcp";
import {
  getSigNozIntegrationState,
  loadSigNozMcpWorkerConnection,
  SIGNOZ_MCP_ENDPOINT_URL,
} from "./integrations/signoz-mcp";
import {
  getSlackMcpIntegrationState,
  loadSlackMcpWorkerConnection,
  SLACK_MCP_ENDPOINT_URL,
} from "./integrations/slack-mcp";
import {
  getStripeMcpIntegrationState,
  loadStripeMcpWorkerConnection,
  STRIPE_MCP_ENDPOINT_URL,
} from "./integrations/stripe";
import {
  getXMcpIntegrationState,
  loadXMcpWorkerConnection,
  X_MCP_ENDPOINT_URL,
} from "./integrations/x-mcp";

const DISCOVERY_TTL_MS = 60 * 60 * 1_000;
const DISCOVERY_RETRY_MS = 5 * 60 * 1_000;

type DbLike = any;
type Identity = { userWorkosId: string; workspaceId: string };

const logger = createLogger({ service: "opencompany-agent", runtime: "plugin-gateway" });

const providerBindings = {
  attio: {
    provider: "attio",
    endpointUrl: ATTIO_MCP_ENDPOINT_URL,
    getState: getAttioMcpIntegrationState,
    loadConnection: loadAttioMcpWorkerConnection,
  },
  betterstack: {
    provider: "betterstack",
    endpointUrl: BETTERSTACK_MCP_ENDPOINT_URL,
    getState: getBetterStackIntegrationState,
    loadConnection: loadBetterStackMcpWorkerConnection,
  },
  github: {
    provider: "github_user",
    endpointUrl: GITHUB_USER_MCP_ENDPOINT_URL,
    getState: getGitHubUserMcpIntegrationState,
    loadConnection: loadGitHubUserMcpWorkerConnection,
  },
  fathom: {
    provider: "fathom",
    endpointUrl: FATHOM_MCP_ENDPOINT_URL,
    getState: getFathomMcpIntegrationState,
    loadConnection: loadFathomMcpWorkerConnection,
  },
  gmail: {
    provider: "gmail",
    endpointUrl: GMAIL_MCP_ENDPOINT_URL,
    getState: getGmailMcpIntegrationState,
    loadConnection: loadGmailMcpWorkerConnection,
  },
  granola: {
    provider: "granola",
    endpointUrl: GRANOLA_MCP_ENDPOINT_URL,
    getState: getGranolaMcpIntegrationState,
    loadConnection: loadGranolaMcpWorkerConnection,
  },
  "google-calendar": {
    provider: "google_calendar",
    endpointUrl: GOOGLE_CALENDAR_MCP_ENDPOINT_URL,
    getState: getGoogleCalendarMcpIntegrationState,
    loadConnection: loadGoogleCalendarMcpWorkerConnection,
  },
  "google-drive": {
    provider: "google_drive",
    endpointUrl: GOOGLE_DRIVE_MCP_ENDPOINT_URL,
    getState: getGoogleDriveMcpIntegrationState,
    loadConnection: loadGoogleDriveMcpWorkerConnection,
  },
  linear: {
    provider: "linear",
    endpointUrl: LINEAR_MCP_ENDPOINT_URL,
    getState: getLinearIntegrationState,
    loadConnection: loadLinearMcpWorkerConnection,
  },
  hubspot: {
    provider: "hubspot",
    endpointUrl: HUBSPOT_MCP_ENDPOINT_URL,
    getState: getHubSpotMcpIntegrationState,
    loadConnection: loadHubSpotMcpWorkerConnection,
  },
  posthog: {
    provider: "posthog",
    endpointUrl: POSTHOG_MCP_ENDPOINT_URL,
    getState: getPostHogIntegrationState,
    loadConnection: loadPostHogMcpWorkerConnection,
  },
  render: {
    provider: "render",
    endpointUrl: RENDER_MCP_ENDPOINT_URL,
    getState: getRenderIntegrationState,
    loadConnection: loadRenderMcpWorkerConnection,
  },
  neon: {
    provider: "neon",
    endpointUrl: NEON_MCP_ENDPOINT_URL,
    getState: getNeonIntegrationState,
    loadConnection: loadNeonMcpWorkerConnection,
  },
  latitude: {
    provider: "latitude",
    endpointUrl: LATITUDE_MCP_ENDPOINT_URL,
    getState: getLatitudeIntegrationState,
    loadConnection: loadLatitudeMcpWorkerConnection,
  },
  jamie: {
    provider: "jamie",
    endpointUrl: JAMIE_MCP_ENDPOINT_URL,
    getState: getJamieMcpIntegrationState,
    loadConnection: loadJamieMcpWorkerConnection,
  },
  slack: {
    provider: "slack",
    endpointUrl: SLACK_MCP_ENDPOINT_URL,
    getState: getSlackMcpIntegrationState,
    loadConnection: loadSlackMcpWorkerConnection,
  },
  signoz: {
    provider: "signoz",
    endpointUrl: SIGNOZ_MCP_ENDPOINT_URL,
    getState: getSigNozIntegrationState,
    loadConnection: loadSigNozMcpWorkerConnection,
  },
  stripe: {
    provider: "stripe",
    endpointUrl: STRIPE_MCP_ENDPOINT_URL,
    getState: getStripeMcpIntegrationState,
    loadConnection: loadStripeMcpWorkerConnection,
  },
  x: {
    provider: "x_account",
    endpointUrl: X_MCP_ENDPOINT_URL,
    getState: getXMcpIntegrationState,
    loadConnection: loadXMcpWorkerConnection,
  },
} as const;

type BoundPluginName = keyof typeof providerBindings;

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
  if (!isBoundPluginName(record.pluginName)) return null;
  const binding = providerBindings[record.pluginName];
  if (record.connectionProvider !== record.pluginName) {
    logger.warn("Plugin MCP binding rejected a mismatched package provider", {
      event: "opencompany.plugin_mcp_binding_rejected",
      plugin_name: record.pluginName,
      server_name: record.server.name,
      connection_provider: record.connectionProvider,
      reason: "package_provider_mismatch",
    });
    return null;
  }
  // Credentials are provider-bound. A package that merely reuses a provider
  // name must never redirect either OAuth or static bearer credentials to
  // another remote server.
  if (normalizeEndpointUrl(record.server.url) !== normalizeEndpointUrl(binding.endpointUrl)) {
    logger.warn("Plugin MCP binding rejected an untrusted endpoint", {
      event: "opencompany.plugin_mcp_binding_rejected",
      plugin_name: record.pluginName,
      server_name: record.server.name,
      endpoint_url: record.server.url,
      reason: "endpoint_mismatch",
    });
    return null;
  }
  let loadConnection = binding.loadConnection as RemoteMcpGatewayRegistration["loadConnection"];
  let server = record.server;
  if (record.pluginName === "google-calendar") {
    loadConnection = (input) =>
      loadGoogleCalendarMcpWorkerConnection({ ...input, registrationId: record.id });
    server = { ...record.server, url: googleCalendarMcpRuntimeEndpointUrl() };
  } else if (record.pluginName === "google-drive") {
    loadConnection = (input) =>
      loadGoogleDriveMcpWorkerConnection({ ...input, registrationId: record.id });
    server = { ...record.server, url: googleDriveMcpRuntimeEndpointUrl() };
  } else if (record.pluginName === "gmail") {
    loadConnection = (input) =>
      loadGmailMcpWorkerConnection({ ...input, registrationId: record.id });
    server = { ...record.server, url: gmailMcpRuntimeEndpointUrl() };
  }
  return {
    source: `plugin:${record.pluginName}:${record.server.name}`,
    connectionProvider: binding.provider,
    label: displayName(record.pluginName),
    description: record.pluginDescription,
    server,
    capabilities: record.capabilities,
    discoverySnapshot: record.discoverySnapshot,
    getState: binding.getState,
    loadConnection,
    isEnabled: () =>
      isPluginGatewayRegistrationActive(db, {
        workspaceId: identity.workspaceId,
        registrationId: record.id,
      }),
  };
}

function isBoundPluginName(value: string): value is BoundPluginName {
  return Object.hasOwn(providerBindings, value);
}

function normalizeEndpointUrl(value: string) {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function displayName(value: string) {
  return value
    .split(/[.-]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
