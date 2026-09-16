import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import {
  isSlackBotConfigured,
  slackBotCanCustomizeIdentity,
  slackBotCanReact,
  slackBotCanReadDirectMessages,
  slackBotScopesSatisfied,
} from "@opencompany/agent/integrations/slack-bot";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import type { Actor } from "@opencompany/core";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import {
  getSlackBotIntegrationForWorkspace,
  parseSlackBotSourceConfig,
  type SlackConversationRef,
} from "@opencompany/db/slack-bot";
import { and, count, eq, sql } from "drizzle-orm";
import { ApiError } from "./errors";

type DbLike = any;
const SLACK_BOT_CHANNEL_LIMIT = 5_000;

export type SlackBotWorkspaceSettings = {
  isAdmin: boolean;
  configured: boolean;
  installed: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "not_connected";
  needsScopeUpgrade: boolean;
  canCustomizeIdentity: boolean;
  canReact: boolean;
  canReadDirectMessages: boolean;
  teamName: string | null;
  statusReason: string | null;
};

export type SlackBotSettingsService = {
  getWorkspaceSettings(actor: Actor): Promise<SlackBotWorkspaceSettings>;
  disconnect(actor: Actor): Promise<void>;
};

export function createSlackBotSettingsService(input: {
  db: DbLike;
  request?: typeof slackApiRequest;
}): SlackBotSettingsService {
  const { db } = input;
  const request = input.request ?? slackApiRequest;

  async function integrationFor(actor: Actor) {
    return getSlackBotIntegrationForWorkspace(actor.workspaceId, db);
  }

  async function workspaceBotToken(actor: Actor): Promise<string | null> {
    const integration = await integrationFor(actor);
    if (!integration || integration.status === "disconnected") return null;
    const credential = await loadIntegrationCredential({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: "slack_bot",
      kind: "oauth_token",
      db,
    }).catch(() => null);
    const token = credential?.payload.access_token;
    return typeof token === "string" && token ? token : null;
  }

  return {
    async getWorkspaceSettings(actor) {
      // Workflow authors need to know whether a custom identity can actually be delivered. Keep
      // connection metadata admin-only, but expose the workspace-level capability to every member.
      const integration = await integrationFor(actor);
      const installed = Boolean(integration && integration.status !== "disconnected");
      const deliveries =
        actor.role === "admin" && integration
          ? await db.execute(
              sql`SELECT id FROM goat.channel_deliveries WHERE integration_id = ${integration.id} AND status IN ('uncertain', 'failed') LIMIT 1`,
            )
          : [];
      const deliveryNeedsAttention =
        (Array.isArray(deliveries) ? deliveries : (deliveries.rows ?? [])).length > 0;
      return {
        isAdmin: actor.role === "admin",
        configured: isSlackBotConfigured(),
        installed,
        status:
          integration && integration.status !== "disconnected"
            ? deliveryNeedsAttention && integration.status === "connected"
              ? "sync_failed"
              : integration.status
            : "not_connected",
        needsScopeUpgrade: Boolean(
          integration &&
            installed &&
            integration.status === "connected" &&
            !slackBotScopesSatisfied(integration.scopes),
        ),
        canCustomizeIdentity: Boolean(
          integration &&
            integration.status === "connected" &&
            slackBotCanCustomizeIdentity(integration.scopes),
        ),
        canReact: Boolean(
          integration && integration.status === "connected" && slackBotCanReact(integration.scopes),
        ),
        canReadDirectMessages: Boolean(
          integration &&
            integration.status === "connected" &&
            slackBotCanReadDirectMessages(integration.scopes),
        ),
        teamName: actor.role === "admin" ? (integration?.connectionLabel ?? null) : null,
        statusReason:
          actor.role !== "admin"
            ? null
            : deliveryNeedsAttention
              ? "A Slack delivery could not be confirmed. It has not been reposted to avoid duplicates."
              : (integration?.statusReason ?? null),
      };
    },

    async disconnect(actor) {
      if (actor.role !== "admin") {
        throw new ApiError(403, "forbidden", "Only workspace admins can manage the Slack bot.");
      }
      const integration = await integrationFor(actor);
      if (!integration) {
        throw new ApiError(404, "not_found", "The Slack bot is not connected.");
      }
      await db.transaction(async (tx: DbLike) => {
        await markIntegrationStatus({
          userWorkosId: integration.userWorkosId,
          integrationId: integration.id,
          provider: "slack_bot",
          status: "disconnected",
          statusReason: "Disconnected by a workspace admin.",
          db: tx,
        });
        await tx.execute(
          sql`UPDATE goat.session_subscriptions SET status = 'closed' WHERE integration_id = ${integration.id}`,
        );
        await tx.execute(
          sql`UPDATE goat.channel_deliveries SET status = 'canceled', error = NULL WHERE integration_id = ${integration.id} AND status = 'pending'`,
        );
      });
    },
  };
}
