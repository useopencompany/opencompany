import { randomInt } from "node:crypto";
import type { Actor } from "@opencompany/core";
import {
  GOAT_ATTIO_CREDENTIAL_KIND,
  GOAT_ATTIO_PROVIDER,
  type GoatAttioApiKeyCredentialPayload,
} from "@opencompany/db/goat-attio";
import {
  consumeGoatImessageChallenge,
  getGoatImessagePairingChallenge,
  incrementGoatImessageChallengeAttempts,
  recordGoatImessageSend,
  upsertGoatImessagePairingChallenge,
} from "@opencompany/db/goat-imessage";
import {
  applyGoatIntegrationCapabilityMode,
  disconnectGoatPersonalIntegration,
  loadGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatBrainSources, goatIntegrations, goatUsers } from "@opencompany/db/goat-schema";
import {
  isGoatCapabilityId,
  isGoatCapabilityMode,
  providerCapability,
} from "@opencompany/goat-agent/actions/capabilities";
import {
  connectGoatImessageIntegration,
  getGoatImessageIntegrationState,
  hashGoatImessagePairingCode,
  normalizeImessagePhoneE164,
  verifyGoatImessagePairingCode,
} from "@opencompany/goat-agent/imessage/connect";
import {
  type GoatImessageProvider,
  resolveGoatImessageProvider,
} from "@opencompany/goat-agent/imessage/provider";
import type {
  GoatAttioProviderState,
  GoatFathomProviderState,
  GoatGranolaProviderState,
  GoatImessageProviderState,
  GoatJamieProviderState,
  GoatStripeProviderState,
} from "@opencompany/goat-agent/integration-state";
import { goatPersonalAccountsFromRows } from "@opencompany/goat-agent/integration-state";
import { captureGoatIntegrationAddedAnalytics } from "@opencompany/goat-agent/integrations/analytics";
import {
  connectGoatAttioIntegration,
  deleteGoatAttioWebhook,
  getGoatAttioIntegrationState,
  hasGoatAttioCommentWriteScopes,
  hasGoatAttioListConfigurationWriteScope,
  hasGoatAttioListReadScopes,
  hasGoatAttioListWriteScopes,
  hasGoatAttioRecordWriteScopes,
  isValidAttioApiKey,
  validateGoatAttioApiKey,
} from "@opencompany/goat-agent/integrations/attio";
import {
  connectGoatFathomIntegration,
  getGoatFathomIntegrationState,
  isValidFathomApiKey,
  validateGoatFathomApiKey,
} from "@opencompany/goat-agent/integrations/fathom";
import {
  connectGoatGranolaIntegration,
  getGoatGranolaIntegrationState,
  isValidGranolaApiKey,
  validateGoatGranolaApiKey,
} from "@opencompany/goat-agent/integrations/granola";
import {
  createOrResetGoatJamieWebhookEndpoint,
  type GoatJamieWebhookSetup,
  saveGoatJamieWebhookApiKey,
} from "@opencompany/goat-agent/integrations/jamie";
import {
  connectGoatStripeIntegration,
  disconnectGoatStripeIntegration,
  getGoatStripeIntegrationState,
  isValidGoatStripeRestrictedApiKey,
  validateGoatStripeRestrictedApiKey,
} from "@opencompany/goat-agent/integrations/stripe";
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
const JAMIE_ADMIN_ONLY_MESSAGE = "Only workspace admins can manage the Jamie integration.";

const IMESSAGE_CODE_TTL_MS = 10 * 60 * 1000;
const IMESSAGE_RESEND_COOLDOWN_MS = 30 * 1000;
const IMESSAGE_MAX_CONFIRM_ATTEMPTS = 5;

export { type GoatJamieWebhookSetup };

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
  connectAttio(actor: Actor, apiKey: string): Promise<GoatAttioProviderState>;
  disconnectAttio(actor: Actor, integrationId: string): Promise<void>;
  connectFathom(actor: Actor, apiKey: string): Promise<GoatFathomProviderState>;
  connectGranola(actor: Actor, apiKey: string): Promise<GoatGranolaProviderState>;
  startImessagePairing(actor: Actor, phone: string): Promise<void>;
  confirmImessagePairing(actor: Actor, code: string): Promise<GoatImessageProviderState>;
  connectStripe(actor: Actor, apiKey: string): Promise<GoatStripeProviderState>;
  disconnectStripe(actor: Actor): Promise<void>;
  createOrResetJamieWebhookEndpoint(actor: Actor): Promise<GoatJamieWebhookSetup>;
  saveJamieWebhookApiKey(actor: Actor, apiKey: string): Promise<GoatJamieWebhookSetup>;
};

export function createIntegrationAccountService(input: {
  db: DbLike;
  now?: () => Date;
  // Injectable so tests can exercise the pairing flow without Linq credentials.
  resolveImessageProvider?: () => GoatImessageProvider | null;
  generatePairingCode?: () => string;
  runner?: RunnerClient;
}): IntegrationAccountService {
  const db = input.db;
  const now = input.now ?? (() => new Date());
  const resolveImessageProvider = input.resolveImessageProvider ?? resolveGoatImessageProvider;
  const generatePairingCode =
    input.generatePairingCode ?? (() => String(randomInt(100000, 1000000)));

  return {
    async list(actor) {
      const rows = await db
        .select({
          id: goatIntegrations.id,
          provider: goatIntegrations.provider,
          workspaceId: goatIntegrations.workspaceId,
          externalId: goatIntegrations.externalId,
          accountEmail: goatIntegrations.accountEmail,
          accountName: goatIntegrations.accountName,
          connectionLabel: goatIntegrations.connectionLabel,
          statusReason: goatIntegrations.statusReason,
          status: goatIntegrations.status,
          scopes: goatIntegrations.scopes,
          capabilityModes: goatIntegrations.capabilityModes,
        })
        .from(goatIntegrations)
        .where(
          and(
            eq(goatIntegrations.userWorkosId, actor.userId),
            isNull(goatIntegrations.workspaceId),
            ne(goatIntegrations.status, "disconnected"),
          ),
        )
        .orderBy(goatIntegrations.createdAt);
      return Object.values(goatPersonalAccountsFromRows(rows))
        .flat()
        .map((account) => ({
          ...account,
          status: account.status as IntegrationAccountDto["status"],
        }));
    },

    async getUsage(actor, integrationId) {
      await requireOwnPersonalIntegration(db, actor, integrationId);
      try {
        const [row] = await db
          .select({ count: sql<number>`count(*)::integer` })
          .from(goatBrainSources)
          .where(eq(goatBrainSources.integrationId, integrationId));
        return { affectedBrainSourceCount: Number(row?.count ?? 0) };
      } catch (error) {
        throw commandFailure(error, "Could not check account usage.", "usage_check");
      }
    },

    async disconnect(actor, integrationId) {
      await disconnectPersonalIntegration(db, actor, integrationId);
    },

    async setCapabilityMode(actor, integrationId, capabilityId, mode) {
      if (!isGoatCapabilityMode(mode) || !isGoatCapabilityId(capabilityId)) {
        throw new ApiError(400, "invalid_request", "Unknown permission mode.");
      }
      await requireOwnPersonalIntegration(db, actor, integrationId);
      const [row] = await db
        .select({ provider: goatIntegrations.provider })
        .from(goatIntegrations)
        .where(eq(goatIntegrations.id, integrationId))
        .limit(1);
      const capability = row ? providerCapability(row.provider, capabilityId) : undefined;
      if (!capability) {
        throw new ApiError(400, "invalid_request", "This integration has no such permission.");
      }
      try {
        await applyGoatIntegrationCapabilityMode({
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
        const validation = await validateGoatAttioApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        if (
          !hasGoatAttioListReadScopes(validation.identity.scopes) ||
          !hasGoatAttioListConfigurationWriteScope(validation.identity.scopes) ||
          !hasGoatAttioRecordWriteScopes(validation.identity.scopes) ||
          !hasGoatAttioListWriteScopes(validation.identity.scopes) ||
          !hasGoatAttioCommentWriteScopes(validation.identity.scopes)
        ) {
          throw new ApiError(
            400,
            "invalid_request",
            "This Attio API key needs object_configuration:read, record_permission:read-write, list_configuration:read-write, list_entry:read-write, and comment:read-write so Chat can read and operate CRM records, lists, pipeline fields, and comments.",
          );
        }
        await connectGoatAttioIntegration({
          userWorkosId: actor.userId,
          apiKey: trimmed,
          identity: validation.identity,
          db,
        });
        return await getGoatAttioIntegrationState(actor.userId, db);
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
      const credential = await loadGoatIntegrationCredential({
        userWorkosId: actor.userId,
        integrationId,
        provider: GOAT_ATTIO_PROVIDER,
        kind: GOAT_ATTIO_CREDENTIAL_KIND,
        db,
      }).catch(() => null);
      const payload = credential?.payload as GoatAttioApiKeyCredentialPayload | undefined;
      if (payload?.apiKey && payload.webhookId) {
        await deleteGoatAttioWebhook({ apiKey: payload.apiKey, webhookId: payload.webhookId });
      }
      await disconnectPersonalIntegration(db, actor, integrationId);
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
        const validation = await validateGoatFathomApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectGoatFathomIntegration({ userWorkosId: actor.userId, apiKey: trimmed, db });
        return await getGoatFathomIntegrationState(actor.userId, db);
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
        const validation = await validateGoatGranolaApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectGoatGranolaIntegration({
          userWorkosId: actor.userId,
          apiKey: trimmed,
          accountEmail: validation.accountEmail,
          accountName: validation.accountName,
          db,
        });
        return await getGoatGranolaIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(error, "Could not save the Granola API key.", "granola_connect");
      }
    },

    async startImessagePairing(actor, phone) {
      const [user] = await db
        .select({ imessageEnabled: goatUsers.imessageEnabled })
        .from(goatUsers)
        .where(eq(goatUsers.workosUserId, actor.userId))
        .limit(1);
      if (!user?.imessageEnabled) {
        throw new ApiError(
          400,
          "invalid_request",
          "Enable iMessage notifications in Preferences first.",
        );
      }
      const provider = resolveImessageProvider();
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
        const existing = await getGoatImessagePairingChallenge(actor.userId, db);
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
        await upsertGoatImessagePairingChallenge(
          {
            userWorkosId: actor.userId,
            phoneE164,
            codeHash: hashGoatImessagePairingCode({
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
          text: `Your OpenCompany verification code is ${code}. It expires in 10 minutes.`,
        });
        await recordGoatImessageSend(
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
        const challenge = await getGoatImessagePairingChallenge(actor.userId, db);
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
          !verifyGoatImessagePairingCode({
            code: trimmed,
            userWorkosId: actor.userId,
            phoneE164: challenge.phoneE164,
            expectedHash: challenge.codeHash,
          })
        ) {
          await incrementGoatImessageChallengeAttempts(challenge.id, db);
          const remaining = IMESSAGE_MAX_CONFIRM_ATTEMPTS - challenge.attemptCount - 1;
          throw new ApiError(
            400,
            "invalid_request",
            remaining > 0
              ? `That code doesn't match. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
              : "That code doesn't match. Request a new code.",
          );
        }

        await consumeGoatImessageChallenge(challenge.id, db);
        await connectGoatImessageIntegration({
          userWorkosId: actor.userId,
          phoneE164: challenge.phoneE164,
          db,
        });
        return await getGoatImessageIntegrationState(actor.userId, db);
      } catch (error) {
        throw commandFailure(error, "Could not verify the code.", "imessage_confirm");
      }
    },

    async connectStripe(actor, apiKey) {
      requireAdmin(actor, STRIPE_ADMIN_ONLY_MESSAGE);
      const trimmed = apiKey.trim();
      if (!isValidGoatStripeRestrictedApiKey(trimmed)) {
        throw new ApiError(
          400,
          "invalid_request",
          "Use a restricted Stripe key beginning with rk_test_ or rk_live_. Unrestricted sk_ keys are not accepted.",
        );
      }
      try {
        const validation = await validateGoatStripeRestrictedApiKey(trimmed);
        if (!validation.ok) throw new ApiError(400, "invalid_request", validation.error);
        await connectGoatStripeIntegration({
          userWorkosId: actor.userId,
          workspaceId: actor.workspaceId,
          apiKey: trimmed,
          identity: validation.identity,
          db,
        });
        return await getGoatStripeIntegrationState(actor.workspaceId, db);
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
        disconnected = await disconnectGoatStripeIntegration(actor.workspaceId, db);
      } catch (error) {
        throw commandFailure(error, "Could not disconnect Stripe.", "stripe_disconnect");
      }
      if (!disconnected) {
        throw new ApiError(404, "not_found", "Stripe is not connected.");
      }
    },

    async createOrResetJamieWebhookEndpoint(actor) {
      // Jamie webhooks are workspace-owned plumbing; only admins manage them.
      requireAdmin(actor, JAMIE_ADMIN_ONLY_MESSAGE);
      try {
        return await createOrResetGoatJamieWebhookEndpoint({
          userWorkosId: actor.userId,
          workspaceId: actor.workspaceId,
          db,
        });
      } catch (error) {
        throw commandFailure(error, "Could not create a Jamie webhook endpoint.", "jamie_endpoint");
      }
    },

    async saveJamieWebhookApiKey(actor, apiKey) {
      requireAdmin(actor, JAMIE_ADMIN_ONLY_MESSAGE);
      try {
        const setup = await saveGoatJamieWebhookApiKey({
          workspaceId: actor.workspaceId,
          apiKey,
          db,
        });
        await captureGoatIntegrationAddedAnalytics({
          userWorkosId: actor.userId,
          workspaceId: actor.workspaceId,
          provider: "jamie",
        });
        return setup;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // The Jamie lib throws plain Errors with user-facing copy for exactly
        // two validation cases; only those messages may cross the boundary.
        // Anything else (driver/network failures) gets the deterministic
        // fallback so raw infra text never reads as an invalid-key response.
        const curated =
          error instanceof Error &&
          (error.message.startsWith("Jamie API keys must start with") ||
            error.message.startsWith("Create a Jamie webhook endpoint"));
        if (curated) {
          throw new ApiError(400, "invalid_request", (error as Error).message);
        }
        throw commandFailure(error, "Could not save the Jamie API key.", "jamie_api_key");
      }
    },
  };
}

async function requireOwnPersonalIntegration(db: DbLike, actor: Actor, integrationId: string) {
  const [row] = await db
    .select({ id: goatIntegrations.id })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, integrationId),
        eq(goatIntegrations.userWorkosId, actor.userId),
        isNull(goatIntegrations.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", OWNER_ONLY_MESSAGE);
}

async function disconnectPersonalIntegration(db: DbLike, actor: Actor, integrationId: string) {
  let deleted: boolean;
  try {
    deleted = await disconnectGoatPersonalIntegration({
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
