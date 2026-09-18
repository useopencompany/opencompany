import {
  isCapabilityId,
  isCapabilityMode,
  isToolMode,
  providerCapability,
} from "@opencompany/agent/actions/capabilities";
import type {
  AttioProviderState,
  ConvexEventsProviderState,
  FathomProviderState,
  GranolaProviderState,
  JamieEventsProviderState,
  PostHogEventsProviderState,
  StripeProviderState,
} from "@opencompany/agent/integration-state";
import { personalAccountsFromRows } from "@opencompany/agent/integration-state";
import {
  connectAttioIntegration,
  deleteAttioWebhook,
  getAttioIntegrationState,
  hasAttioCommentWriteScopes,
  hasAttioListConfigurationWriteScope,
  hasAttioListReadScopes,
  hasAttioListWriteScopes,
  hasAttioRecordWriteScopes,
  isValidAttioApiKey,
  validateAttioApiKey,
} from "@opencompany/agent/integrations/attio";
import {
  ConvexLogStreamError,
  disableConvexErrorEvents,
  enableConvexErrorEvents,
  getConvexEventsIntegrationState,
} from "@opencompany/agent/integrations/convex-log-stream";
import {
  type ConvexProviderState,
  connectConvexMcpIntegration,
  getConvexIntegrationState,
  validateConvexApiKey,
} from "@opencompany/agent/integrations/convex-mcp";
import { parseConvexDeployKey } from "@opencompany/agent/integrations/convex-policy";
import {
  connectFathomIntegration,
  getFathomIntegrationState,
  isValidFathomApiKey,
  validateFathomApiKey,
} from "@opencompany/agent/integrations/fathom";
import {
  connectGranolaIntegration,
  getGranolaIntegrationState,
  isValidGranolaApiKey,
  validateGranolaApiKey,
} from "@opencompany/agent/integrations/granola";
import {
  ensureJamieEventsEndpoint,
  getJamieEventsIntegrationState,
  isValidJamieWebhookKey,
  saveJamieWebhookKey,
} from "@opencompany/agent/integrations/jamie-events";
import {
  connectPostHogEventsIntegration,
  getPostHogEventsIntegrationState,
  isValidPostHogApiKey,
  isValidPostHogProjectId,
  listPostHogEventDefinitions,
  type PostHogEventsCredentialPayload,
  type PostHogRegion,
  validatePostHogEventsConnection,
} from "@opencompany/agent/integrations/posthog-events";
import {
  connectRenderMcpIntegration,
  getRenderIntegrationState,
  isValidRenderApiKey,
  type RenderProviderState,
  validateRenderApiKey,
} from "@opencompany/agent/integrations/render-mcp";
import { disconnectStripeIntegration } from "@opencompany/agent/integrations/stripe";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import type { Actor } from "@opencompany/core";
import {
  ATTIO_CREDENTIAL_KIND,
  ATTIO_PROVIDER,
  type AttioApiKeyCredentialPayload,
} from "@opencompany/db/attio";
import {
  applyIntegrationCapabilityMode,
  applyIntegrationToolMode,
  disconnectPersonalIntegration,
  loadIntegrationCredential,
} from "@opencompany/db/integrations";
import {
  POSTHOG_EVENTS_CREDENTIAL_KIND,
  POSTHOG_EVENTS_EXTERNAL_ID,
  POSTHOG_PROVIDER,
} from "@opencompany/db/posthog-events";
import { brainSources, integrations } from "@opencompany/db/product-schema";
import { createLogger } from "@opencompany/observability";
import type { IntegrationAccountDto } from "@opencompany/protocol";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { ApiError } from "./errors";
import type { RunnerClient } from "./runner-client";

const logger = createLogger({ service: "opencompany-api", runtime: "integration-accounts" });

// Follows the repo-wide injectable-db convention for services that only need a
// drizzle handle without dragging the full inferred schema type across packages.
type DbLike = any;

const OWNER_ONLY_MESSAGE = "Only the connection owner can manage this account.";
const STRIPE_ADMIN_ONLY_MESSAGE = "Only workspace admins can manage the Stripe integration.";

export type IntegrationAccountService = {
  list(actor: Actor): Promise<IntegrationAccountDto[]>;
  getUsage(actor: Actor, integrationId: string): Promise<{ affectedBrainSourceCount: number }>;
  disconnect(actor: Actor, integrationId: string): Promise<void>;
  setCapabilityMode(
    actor: Actor,
    integrationId: string,
    capabilityId: string,
    mode: string,
  ): Promise<void>;
  setToolMode(actor: Actor, integrationId: string, toolId: string, mode: string): Promise<void>;
  alwaysAllowAction(actor: Actor, actionId: string): Promise<void>;
  connectAttio(actor: Actor, apiKey: string): Promise<AttioProviderState>;
  disconnectAttio(actor: Actor, integrationId: string): Promise<void>;
  connectFathom(actor: Actor, apiKey: string): Promise<FathomProviderState>;
  connectGranola(actor: Actor, apiKey: string): Promise<GranolaProviderState>;
  connectPostHogEvents(
    actor: Actor,
    input: { apiKey: string; projectId: string; region: PostHogRegion },
  ): Promise<PostHogEventsProviderState>;
  listPostHogEvents(
    actor: Actor,
    integrationId: string,
  ): Promise<{ events: Array<{ id: string; name: string }>; partial: boolean }>;
  createJamieEventsEndpoint(actor: Actor): Promise<JamieEventsProviderState>;
  connectJamieEvents(actor: Actor, webhookKey: string): Promise<JamieEventsProviderState>;
  connectConvex(actor: Actor, apiKey: string): Promise<ConvexProviderState>;
  enableConvexEvents(actor: Actor): Promise<ConvexEventsProviderState>;
  disableConvexEvents(actor: Actor): Promise<void>;
  connectRender(actor: Actor, apiKey: string): Promise<RenderProviderState>;
  connectStripe(actor: Actor, apiKey: string): Promise<StripeProviderState>;
  disconnectStripe(actor: Actor): Promise<void>;
};

const VALID_TOOL_ID = /^[A-Za-z0-9_.:-]+$/u;

export function createIntegrationAccountService(input: {
  db: DbLike;
  now?: () => Date;
  runner?: RunnerClient;
  refreshConvexPluginRegistrations?: (input: {
    userWorkosId: string;
    workspaceId: string;
  }) => Promise<void>;
  refreshRenderPluginRegistrations?: (input: {
    userWorkosId: string;
    workspaceId: string;
  }) => Promise<void>;
}): IntegrationAccountService {
  const db = input.db;
  const now = input.now ?? (() => new Date());
  return {
    async list(actor) {
      const rows = await db
        .select({
          id: integrations.id,
          provider: integrations.provider,
          workspaceId: integrations.workspaceId,
          externalId: integrations.externalId,
          accountEmail: integrations.accountEmail,
          accountName: integrations.accountName,
          connectionLabel: integrations.connectionLabel,
          statusReason: integrations.statusReason,
          status: integrations.status,
          scopes: integrations.scopes,
          capabilityModes: integrations.capabilityModes,
          toolModes: integrations.toolModes,
        })
        .from(integrations)
        .where(
          and(
            eq(integrations.userWorkosId, actor.userId),
            isNull(integrations.workspaceId),
            ne(integrations.status, "disconnected"),
          ),
        )
        .orderBy(integrations.createdAt);
      return Object.values(personalAccountsFromRows(rows))
        .flat()
        .map((account) => ({
          ...account,
          status: account.status as IntegrationAccountDto["status"],
        }));
    },

    async getUsage(actor, integrationId) {
      const integration = await requireOwnPersonalIntegration(db, actor, integrationId);
      if (integration.provider === "slack") {
        return { affectedBrainSourceCount: 0 };
      }
      try {
        const [row] = await db
          .select({ count: sql<number>`count(*)::integer` })
          .from(brainSources)
          .where(eq(brainSources.integrationId, integrationId));
        return { affectedBrainSourceCount: Number(row?.count ?? 0) };
      } catch (error) {
        throw commandFailure(error, "Could not check account usage.", "usage_check");
      }
    },

    async disconnect(actor, integrationId) {
      await disconnectOwnedPersonalIntegration(db, actor, integrationId);
    },

    async setCapabilityMode(actor, integrationId, capabilityId, mode) {
      if (!isCapabilityMode(mode) || !isCapabilityId(capabilityId)) {
        throw new ApiError(400, "invalid_request", "Unknown permission mode.");
      }
      const integration = await requireManageableCapabilityIntegration(db, actor, integrationId);
      const capability = providerCapability(integration.provider, capabilityId);
      if (!capability) {
        throw new ApiError(400, "invalid_request", "This integration has no such permission.");
      }
      try {
        await applyIntegrationCapabilityMode({
          integrationIds: [integrationId],
          capabilityId,
          mode,
          db,
          now: now(),
        });
      } catch (error) {
        throw commandFailure(error, "Could not update the permission.", "capability_mode");
      }
    },

    async setToolMode(actor, integrationId, toolId, mode) {
      // "inherit" is the only way to clear a tool back to its capability group, so it is a valid
      // input here even though it is never a stored value.
      if (!isToolMode(mode)) {
        throw new ApiError(400, "invalid_request", "Unknown permission mode.");
      }
      const trimmedTool = toolId.trim();
      if (!trimmedTool || trimmedTool.length > 128 || !VALID_TOOL_ID.test(trimmedTool)) {
        throw new ApiError(400, "invalid_request", "A valid tool is required.");
      }
      await requireManageableCapabilityIntegration(db, actor, integrationId);
      try {
        await applyIntegrationToolMode({
          integrationIds: [integrationId],
          toolId: trimmedTool,
          mode: mode === "inherit" ? null : mode,
          db,
          now: now(),
        });
      } catch (error) {
        throw commandFailure(error, "Could not update the permission.", "tool_mode");
      }
    },

    async alwaysAllowAction(actor, actionId) {
      const trimmed = actionId.trim();
      if (!trimmed || trimmed.length > 255) {
        throw new ApiError(400, "invalid_request", "A valid action is required.");
      }
      if (!input.runner) {
        throw new ApiError(503, "unavailable", "The action permission service is unavailable.");
      }
      try {
        await input.runner.postJson(
          "/internal/goat/actions/always-allow",
          {
            userWorkosId: actor.userId,
            workspaceId: actor.workspaceId,
            actionId: trimmed,
          },
          { errorFormat: "error-message" },
        );
      } catch (error) {
        throw commandFailure(error, "Could not update the permission.", "always_allow_action");
      }
    },

    async connectAttio(actor, apiKey) {
      const trimmed = apiKey.trim();
      if (!isValidAttioApiKey(trimmed)) {
        throw new ApiError(
          400,
          "invalid_request",
          "This does not look like an Attio API key. Check it and try again.",
        );
      }
      try {
        const validation = await validateAttioApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        if (
          !hasAttioListReadScopes(validation.identity.scopes) ||
          !hasAttioListConfigurationWriteScope(validation.identity.scopes) ||
          !hasAttioRecordWriteScopes(validation.identity.scopes) ||
          !hasAttioListWriteScopes(validation.identity.scopes) ||
          !hasAttioCommentWriteScopes(validation.identity.scopes)
        ) {
          throw new ApiError(
            400,
            "invalid_request",
            "This Attio API key needs object_configuration:read, record_permission:read-write, list_configuration:read-write, list_entry:read-write, and comment:read-write so Chat can read and operate CRM records, lists, pipeline fields, and comments.",
          );
        }
        await connectAttioIntegration({
          userWorkosId: actor.userId,
          apiKey: trimmed,
          identity: validation.identity,
          db,
        });
        return await getAttioIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(
          error,
          "Could not connect Attio. Make sure the key has object_configuration:read, record_permission:read-write, list_configuration:read-write, list_entry:read-write, comment:read-write, note:read-write, and webhook:read-write, then try again.",
          "attio_connect",
        );
      }
    },

    async disconnectAttio(actor, integrationId) {
      // Attio disconnect removes the webhook Attio-side first (best effort —
      // the key may already be revoked), then hard-deletes the integration
      // like every other personal account.
      const credential = await loadIntegrationCredential({
        userWorkosId: actor.userId,
        integrationId,
        provider: ATTIO_PROVIDER,
        kind: ATTIO_CREDENTIAL_KIND,
        db,
      }).catch(() => null);
      const payload = credential?.payload as AttioApiKeyCredentialPayload | undefined;
      if (payload?.apiKey && payload.webhookId) {
        await deleteAttioWebhook({ apiKey: payload.apiKey, webhookId: payload.webhookId });
      }
      await disconnectOwnedPersonalIntegration(db, actor, integrationId);
    },

    async connectFathom(actor, apiKey) {
      const trimmed = apiKey.trim();
      if (!isValidFathomApiKey(trimmed)) {
        throw new ApiError(
          400,
          "invalid_request",
          "This does not look like a Fathom API key. Check it and try again.",
        );
      }
      try {
        const validation = await validateFathomApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectFathomIntegration({ userWorkosId: actor.userId, apiKey: trimmed, db });
        return await getFathomIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(error, "Could not save the Fathom API key.", "fathom_connect");
      }
    },

    async connectGranola(actor, apiKey) {
      const trimmed = apiKey.trim();
      if (!isValidGranolaApiKey(trimmed)) {
        throw new ApiError(
          400,
          "invalid_request",
          "Granola API keys start with grn_. Check the key and try again.",
        );
      }
      try {
        const validation = await validateGranolaApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectGranolaIntegration({
          userWorkosId: actor.userId,
          apiKey: trimmed,
          accountEmail: validation.accountEmail,
          accountName: validation.accountName,
          db,
        });
        return await getGranolaIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(error, "Could not save the Granola API key.", "granola_connect");
      }
    },

    async connectPostHogEvents(actor, connection) {
      const apiKey = connection.apiKey.trim();
      const projectId = connection.projectId.trim();
      if (!isValidPostHogApiKey(apiKey)) {
        throw new ApiError(
          400,
          "invalid_request",
          "PostHog personal API keys start with phx_. Check the key and try again.",
        );
      }
      if (!isValidPostHogProjectId(projectId)) {
        throw new ApiError(400, "invalid_request", "Enter a valid numeric PostHog project ID.");
      }
      try {
        const validation = await validatePostHogEventsConnection({
          apiKey,
          projectId,
          region: connection.region,
        });
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectPostHogEventsIntegration({
          userWorkosId: actor.userId,
          apiKey,
          projectId,
          region: connection.region,
          db,
        });
        return await getPostHogEventsIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(
          error,
          "Could not connect PostHog. Check the region, project ID, and key permissions.",
          "posthog_events_connect",
        );
      }
    },

    async listPostHogEvents(actor, integrationId) {
      const integration = await requireOwnPersonalIntegration(db, actor, integrationId);
      if (
        integration.provider !== POSTHOG_PROVIDER ||
        integration.externalId !== POSTHOG_EVENTS_EXTERNAL_ID
      ) {
        throw new ApiError(404, "not_found", "PostHog event connection not found.");
      }
      const credential = await loadIntegrationCredential({
        userWorkosId: actor.userId,
        integrationId,
        provider: POSTHOG_PROVIDER,
        kind: POSTHOG_EVENTS_CREDENTIAL_KIND,
        db,
      });
      const payload = credential?.payload as PostHogEventsCredentialPayload | undefined;
      if (
        !payload ||
        !isValidPostHogApiKey(payload.apiKey) ||
        !isValidPostHogProjectId(payload.projectId) ||
        (payload.region !== "us" && payload.region !== "eu")
      ) {
        throw new ApiError(401, "unauthorized", "Reconnect PostHog to load events.");
      }
      const result = await listPostHogEventDefinitions({ credential: payload });
      if (!result.ok) {
        throw new ApiError(
          result.reason === "unauthorized" ? 401 : 503,
          result.reason === "unauthorized" ? "unauthorized" : "unavailable",
          result.error,
          result.reason === "unavailable",
        );
      }
      return { events: result.events, partial: result.partial };
    },

    // Jamie has no webhook-management API, so the endpoint has to exist before the user can point
    // Jamie at it. Creating one is idempotent: a second call returns the URL already in Jamie.
    async createJamieEventsEndpoint(actor) {
      try {
        await ensureJamieEventsEndpoint({ userWorkosId: actor.userId, db });
        return await getJamieEventsIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(
          error,
          "Could not create the Jamie webhook endpoint.",
          "jamie_events_endpoint",
        );
      }
    },

    // Jamie mints the key when the webhook is created and exposes nothing that can validate it, so
    // the save is trusted and the Events section reports the first verified delivery instead.
    async connectJamieEvents(actor, webhookKey) {
      const trimmed = webhookKey.trim();
      if (!isValidJamieWebhookKey(trimmed)) {
        throw new ApiError(
          400,
          "invalid_request",
          "Jamie webhook keys start with sk_. Check the key and try again.",
        );
      }
      try {
        await saveJamieWebhookKey({
          userWorkosId: actor.userId,
          webhookSecret: trimmed,
          db,
        });
        return await getJamieEventsIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(
          error,
          "Could not save the Jamie webhook key.",
          "jamie_events_connect",
        );
      }
    },

    async connectConvex(actor, apiKey) {
      const trimmed = apiKey.trim();
      if (!parseConvexDeployKey(trimmed)) {
        throw new ApiError(
          400,
          "invalid_request",
          "Use a deployment-scoped Convex key starting with dev: or prod:.",
        );
      }
      try {
        const validation = await validateConvexApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectConvexMcpIntegration({
          userWorkosId: actor.userId,
          apiKey: trimmed,
          deployment: validation.deployment,
          db,
        });
        await input
          .refreshConvexPluginRegistrations?.({
            userWorkosId: actor.userId,
            workspaceId: actor.workspaceId,
          })
          .catch((error) => {
            logger.warn("Convex connected but plugin discovery refresh failed", {
              event: "opencompany.convex_plugin_refresh_failed",
              error_message: error instanceof Error ? error.message : String(error),
            });
          });
        return await getConvexIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(error, "Could not save the Convex API key.", "convex_connect");
      }
    },

    // Provisioning the log stream is one call because the deploy key stored for the Convex plugin
    // is also what the Convex deployment API accepts. Convex's own refusals — a missing
    // deployment:integrations:write permission, a team below Pro — are specific enough to show as
    // written, so they surface as invalid_request rather than a generic failure.
    async enableConvexEvents(actor) {
      try {
        await enableConvexErrorEvents({ userWorkosId: actor.userId, db });
        return await getConvexEventsIntegrationState(actor.userId, db);
      } catch (error) {
        if (error instanceof ConvexLogStreamError) {
          throw new ApiError(400, "invalid_request", error.message);
        }
        throw commandFailure(
          error,
          "Could not turn on Convex error events.",
          "convex_events_enable",
        );
      }
    },

    async disableConvexEvents(actor) {
      try {
        await disableConvexErrorEvents({ userWorkosId: actor.userId, db });
      } catch (error) {
        if (error instanceof ConvexLogStreamError) {
          throw new ApiError(400, "invalid_request", error.message);
        }
        throw commandFailure(
          error,
          "Could not turn off Convex error events.",
          "convex_events_disable",
        );
      }
    },

    async connectRender(actor, apiKey) {
      const trimmed = apiKey.trim();
      if (!isValidRenderApiKey(trimmed)) {
        throw new ApiError(
          400,
          "invalid_request",
          "Render API keys start with rnd_. Check the key and try again.",
        );
      }
      try {
        const validation = await validateRenderApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectRenderMcpIntegration({
          userWorkosId: actor.userId,
          apiKey: trimmed,
          owner: validation.owner,
          db,
        });
        await input
          .refreshRenderPluginRegistrations?.({
            userWorkosId: actor.userId,
            workspaceId: actor.workspaceId,
          })
          .catch((error) => {
            logger.warn("Render connected but plugin discovery refresh failed", {
              event: "opencompany.render_plugin_refresh_failed",
              error_message: error instanceof Error ? error.message : String(error),
            });
          });
        return await getRenderIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(error, "Could not save the Render API key.", "render_connect");
      }
    },

    async connectStripe() {
      throw new ApiError(
        410,
        "invalid_request",
        "Workspace Stripe keys are retired. Connect your personal Stripe account in Plugins settings.",
      );
    },

    async disconnectStripe(actor) {
      requireAdmin(actor, STRIPE_ADMIN_ONLY_MESSAGE);
      let disconnected: boolean;
      try {
        disconnected = await disconnectStripeIntegration(actor.workspaceId, db);
      } catch (error) {
        throw commandFailure(error, "Could not disconnect Stripe.", "stripe_disconnect");
      }
      if (!disconnected) {
        throw new ApiError(404, "not_found", "Stripe is not connected.");
      }
      await captureProductServerEvent("connection_removed", actor.userId, {
        workspace_id: actor.workspaceId,
        provider: "stripe",
      });
    },
  };
}

async function requireOwnPersonalIntegration(db: DbLike, actor: Actor, integrationId: string) {
  const [row] = await db
    .select({
      id: integrations.id,
      provider: integrations.provider,
      externalId: integrations.externalId,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.userWorkosId, actor.userId),
        isNull(integrations.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", OWNER_ONLY_MESSAGE);
  return row;
}

async function requireManageableCapabilityIntegration(
  db: DbLike,
  actor: Actor,
  integrationId: string,
) {
  const [row] = await db
    .select({
      id: integrations.id,
      provider: integrations.provider,
      userWorkosId: integrations.userWorkosId,
      workspaceId: integrations.workspaceId,
    })
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", OWNER_ONLY_MESSAGE);

  if (row.workspaceId !== null) {
    throw new ApiError(404, "not_found", OWNER_ONLY_MESSAGE);
  }

  if (row.userWorkosId !== actor.userId) {
    throw new ApiError(404, "not_found", OWNER_ONLY_MESSAGE);
  }
  return row;
}

async function disconnectOwnedPersonalIntegration(db: DbLike, actor: Actor, integrationId: string) {
  const connection = await requireOwnPersonalIntegration(db, actor, integrationId);
  let deleted: boolean;
  try {
    deleted = await disconnectPersonalIntegration({
      userWorkosId: actor.userId,
      integrationId,
      db,
    });
  } catch (error) {
    throw commandFailure(error, "Could not disconnect this account.", "disconnect");
  }
  if (!deleted) throw new ApiError(404, "not_found", OWNER_ONLY_MESSAGE);
  await captureProductServerEvent("connection_removed", actor.userId, {
    workspace_id: actor.workspaceId,
    provider: connection.provider,
    connection_id: connection.id,
  });
}

function requireAdmin(actor: Actor, message: string) {
  if (actor.role !== "admin") throw new ApiError(403, "forbidden", message);
}

// Mirrors the retired Server Actions' catch-all copy: unexpected failures keep
// their deterministic, human-readable message instead of degrading to a
// generic internal error. Never logs key material.
function commandFailure(error: unknown, message: string, command: string): ApiError {
  if (error instanceof ApiError) return error;
  logger.error("Integration account command failed", {
    event: "opencompany.api_integration_account_command_failed",
    command,
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
  });
  return new ApiError(503, "unavailable", message, true);
}
