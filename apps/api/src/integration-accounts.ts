import { randomInt } from "node:crypto";
import {
  isCapabilityId,
  isCapabilityMode,
  providerCapability,
} from "@opencompany/agent/actions/capabilities";
import {
  connectImessageIntegration,
  getImessageIntegrationState,
  hashImessagePairingCode,
  normalizeImessagePhoneE164,
  verifyImessagePairingCode,
} from "@opencompany/agent/imessage/connect";
import {
  type ImessageProvider,
  resolveImessageProvider,
} from "@opencompany/agent/imessage/provider";
import type {
  AttioProviderState,
  FathomProviderState,
  GranolaProviderState,
  ImessageProviderState,
  JamieProviderState,
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
  connectRenderMcpIntegration,
  getRenderIntegrationState,
  isValidRenderApiKey,
  type RenderProviderState,
  validateRenderApiKey,
} from "@opencompany/agent/integrations/render-mcp";
import {
  connectStripeIntegration,
  disconnectStripeIntegration,
  getStripeIntegrationState,
  isValidStripeRestrictedApiKey,
  validateStripeRestrictedApiKey,
} from "@opencompany/agent/integrations/stripe";
import type { Actor } from "@opencompany/core";
import {
  ATTIO_CREDENTIAL_KIND,
  ATTIO_PROVIDER,
  type AttioApiKeyCredentialPayload,
} from "@opencompany/db/attio";
import {
  consumeImessageChallenge,
  getImessagePairingChallenge,
  incrementImessageChallengeAttempts,
  recordImessageSend,
  upsertImessagePairingChallenge,
} from "@opencompany/db/imessage";
import {
  applyIntegrationCapabilityMode,
  disconnectPersonalIntegration,
  loadIntegrationCredential,
} from "@opencompany/db/integrations";
import { brainSources, integrations, users } from "@opencompany/db/product-schema";
import { ensureWikiSourceEnabledOnConnect } from "@opencompany/db/wiki-sources";
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

const IMESSAGE_CODE_TTL_MS = 10 * 60 * 1000;
const IMESSAGE_RESEND_COOLDOWN_MS = 30 * 1000;
const IMESSAGE_MAX_CONFIRM_ATTEMPTS = 5;

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
  alwaysAllowAction(actor: Actor, actionId: string): Promise<void>;
  connectAttio(actor: Actor, apiKey: string): Promise<AttioProviderState>;
  disconnectAttio(actor: Actor, integrationId: string): Promise<void>;
  connectFathom(actor: Actor, apiKey: string): Promise<FathomProviderState>;
  connectGranola(actor: Actor, apiKey: string): Promise<GranolaProviderState>;
  connectRender(actor: Actor, apiKey: string): Promise<RenderProviderState>;
  startImessagePairing(actor: Actor, phone: string): Promise<void>;
  confirmImessagePairing(actor: Actor, code: string): Promise<ImessageProviderState>;
  connectStripe(actor: Actor, apiKey: string): Promise<StripeProviderState>;
  disconnectStripe(actor: Actor): Promise<void>;
};

export function createIntegrationAccountService(input: {
  db: DbLike;
  now?: () => Date;
  // Injectable so tests can exercise the pairing flow without Linq credentials.
  resolveImessageProvider?: () => ImessageProvider | null;
  generatePairingCode?: () => string;
  runner?: RunnerClient;
  refreshRenderPluginRegistrations?: (input: {
    userWorkosId: string;
    workspaceId: string;
  }) => Promise<void>;
  refreshStripePluginRegistrations?: (input: {
    userWorkosId: string;
    workspaceId: string;
  }) => Promise<void>;
}): IntegrationAccountService {
  const db = input.db;
  const now = input.now ?? (() => new Date());
  const imessageProviderResolver = input.resolveImessageProvider ?? resolveImessageProvider;
  const generatePairingCode =
    input.generatePairingCode ?? (() => String(randomInt(100000, 1000000)));

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
        const connection = await connectGranolaIntegration({
          userWorkosId: actor.userId,
          apiKey: trimmed,
          accountEmail: validation.accountEmail,
          accountName: validation.accountName,
          db,
        });
        await ensureWikiSourceEnabledOnConnect({
          workspaceId: actor.workspaceId,
          provider: "granola",
          integrationId: connection.integrationId,
          userWorkosId: actor.userId,
          createdByWorkosId: actor.userId,
          db,
        });
        return await getGranolaIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(error, "Could not save the Granola API key.", "granola_connect");
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

    async startImessagePairing(actor, phone) {
      const [user] = await db
        .select({ imessageEnabled: users.imessageEnabled })
        .from(users)
        .where(eq(users.workosUserId, actor.userId))
        .limit(1);
      if (!user?.imessageEnabled) {
        throw new ApiError(
          400,
          "invalid_request",
          "Enable iMessage notifications in Preferences first.",
        );
      }
      const provider = imessageProviderResolver();
      if (!provider) {
        throw new ApiError(
          503,
          "unavailable",
          "iMessage sending is not configured on this environment.",
          true,
        );
      }
      const phoneE164 = normalizeImessagePhoneE164(phone);
      if (!phoneE164) {
        throw new ApiError(
          400,
          "invalid_request",
          "Enter the number in international format, e.g. +14155551234.",
        );
      }

      try {
        const existing = await getImessagePairingChallenge(actor.userId, db);
        if (
          existing &&
          !existing.consumedAt &&
          now().getTime() - existing.createdAt.getTime() < IMESSAGE_RESEND_COOLDOWN_MS
        ) {
          throw new ApiError(
            429,
            "rate_limited",
            "A code was just sent. Wait a moment before requesting another.",
            true,
          );
        }

        const code = generatePairingCode();
        await upsertImessagePairingChallenge(
          {
            userWorkosId: actor.userId,
            phoneE164,
            codeHash: hashImessagePairingCode({
              code,
              userWorkosId: actor.userId,
              phoneE164,
            }),
            expiresAt: new Date(now().getTime() + IMESSAGE_CODE_TTL_MS),
          },
          db,
        );

        const sendResult = await provider.send({
          to: phoneE164,
          text: `Your opencompany verification code is ${code}. It expires in 10 minutes.`,
        });
        await recordImessageSend(
          {
            userWorkosId: actor.userId,
            source: "pairing",
            status: sendResult.ok ? "sent" : "failed",
            errorReason: sendResult.ok ? null : sendResult.error,
          },
          db,
        );
        if (!sendResult.ok) {
          throw new ApiError(503, "unavailable", sendResult.error, true);
        }
      } catch (error) {
        throw commandFailure(error, "Could not send the verification code.", "imessage_pairing");
      }
    },

    async confirmImessagePairing(actor, code) {
      const trimmed = code.trim();
      if (!/^\d{6}$/.test(trimmed)) {
        throw new ApiError(400, "invalid_request", "Enter the 6-digit code from the message.");
      }
      try {
        const challenge = await getImessagePairingChallenge(actor.userId, db);
        if (!challenge || challenge.consumedAt) {
          throw new ApiError(
            400,
            "invalid_request",
            "No pending verification. Request a new code.",
          );
        }
        if (challenge.expiresAt.getTime() < now().getTime()) {
          throw new ApiError(400, "invalid_request", "That code expired. Request a new one.");
        }
        if (challenge.attemptCount >= IMESSAGE_MAX_CONFIRM_ATTEMPTS) {
          throw new ApiError(429, "rate_limited", "Too many attempts. Request a new code.");
        }
        if (
          !verifyImessagePairingCode({
            code: trimmed,
            userWorkosId: actor.userId,
            phoneE164: challenge.phoneE164,
            expectedHash: challenge.codeHash,
          })
        ) {
          await incrementImessageChallengeAttempts(challenge.id, db);
          const remaining = IMESSAGE_MAX_CONFIRM_ATTEMPTS - challenge.attemptCount - 1;
          throw new ApiError(
            400,
            "invalid_request",
            remaining > 0
              ? `That code doesn't match. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
              : "That code doesn't match. Request a new code.",
          );
        }

        await consumeImessageChallenge(challenge.id, db);
        await connectImessageIntegration({
          userWorkosId: actor.userId,
          phoneE164: challenge.phoneE164,
          db,
        });
        return await getImessageIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(error, "Could not verify the code.", "imessage_confirm");
      }
    },

    async connectStripe(actor, apiKey) {
      requireAdmin(actor, STRIPE_ADMIN_ONLY_MESSAGE);
      const trimmed = apiKey.trim();
      if (!isValidStripeRestrictedApiKey(trimmed)) {
        throw new ApiError(
          400,
          "invalid_request",
          "Use a restricted Stripe key beginning with rk_test_ or rk_live_. Unrestricted sk_ keys are not accepted.",
        );
      }
      try {
        const validation = await validateStripeRestrictedApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectStripeIntegration({
          userWorkosId: actor.userId,
          workspaceId: actor.workspaceId,
          apiKey: trimmed,
          identity: validation.identity,
          db,
        });
        await input
          .refreshStripePluginRegistrations?.({
            userWorkosId: actor.userId,
            workspaceId: actor.workspaceId,
          })
          .catch((error) => {
            logger.warn("Stripe connected but plugin discovery refresh failed", {
              event: "opencompany.stripe_plugin_refresh_failed",
              error_message: error instanceof Error ? error.message : String(error),
            });
          });
        return await getStripeIntegrationState(actor.workspaceId, db);
      } catch (error) {
        throw commandFailure(
          error,
          "Could not connect Stripe. Check the restricted key and try again.",
          "stripe_connect",
        );
      }
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
    },
  };
}

async function requireOwnPersonalIntegration(db: DbLike, actor: Actor, integrationId: string) {
  const [row] = await db
    .select({ id: integrations.id, provider: integrations.provider })
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
    if (row.workspaceId !== actor.workspaceId) {
      throw new ApiError(404, "not_found", OWNER_ONLY_MESSAGE);
    }
    requireAdmin(actor, "Only workspace admins can manage this integration's permissions.");
    return row;
  }

  if (row.userWorkosId !== actor.userId) {
    throw new ApiError(404, "not_found", OWNER_ONLY_MESSAGE);
  }
  return row;
}

async function disconnectOwnedPersonalIntegration(db: DbLike, actor: Actor, integrationId: string) {
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
