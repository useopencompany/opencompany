import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import {
  isSlackBotConfigured,
  slackBotScopesSatisfied,
} from "@opencompany/agent/integrations/slack-bot";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import type { Actor } from "@opencompany/core";
import { upsertBrainSource } from "@opencompany/db/brain-sources";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import { brainSources } from "@opencompany/db/product-schema";
import { parseSlackBrainSourceConfig, type SlackConversationRef } from "@opencompany/db/slack";
import { getSlackBotIntegrationForWorkspace } from "@opencompany/db/slack-bot";
import { getBrainAccess } from "@opencompany/db/workspaces";
import { and, count, eq } from "drizzle-orm";
import { ApiError } from "./errors";

type DbLike = any;
const SLACK_BOT_CHANNEL_LIMIT = 5_000;

export type SlackBotChannel = SlackConversationRef & {
  isPrivate: boolean;
  isMember: boolean;
};

export type SlackBotWorkspaceSettings = {
  isAdmin: boolean;
  configured: boolean;
  installed: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "not_connected";
  needsScopeUpgrade: boolean;
  teamName: string | null;
  statusReason: string | null;
  destinationCount: number;
};

export type SlackBotDestination = {
  installed: boolean;
  botConnected: boolean;
  isAdmin: boolean;
  brainVisibility: "workspace" | "restricted";
  source: { enabled: boolean; channels: SlackConversationRef[] } | null;
};

export type SlackBotSettingsService = {
  getWorkspaceSettings(actor: Actor): Promise<SlackBotWorkspaceSettings>;
  disconnect(actor: Actor): Promise<void>;
  getDestination(actor: Actor, brainId: string): Promise<SlackBotDestination>;
  listChannels(
    actor: Actor,
    brainId: string,
  ): Promise<{ channels: SlackBotChannel[]; partial: boolean }>;
  setDestination(
    actor: Actor,
    brainId: string,
    input: { enabled: boolean; channels: SlackConversationRef[] },
  ): Promise<void>;
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

  async function requireAdminBrain(actor: Actor, brainId: string) {
    if (actor.role !== "admin") {
      throw new ApiError(403, "forbidden", "Only workspace admins can configure the Slack bot.");
    }
    const access = await getBrainAccess({ userWorkosId: actor.userId, brainRef: brainId }, { db });
    if (!access || access.brain.workspaceId !== actor.workspaceId) {
      throw new ApiError(404, "not_found", "Brain not found.");
    }
    return access;
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
      const integration = actor.role === "admin" ? await integrationFor(actor) : null;
      const installed = Boolean(integration && integration.status !== "disconnected");
      let destinationCount = 0;
      if (integration && installed) {
        const [row] = await db
          .select({ value: count() })
          .from(brainSources)
          .where(
            and(
              eq(brainSources.integrationId, integration.id),
              eq(brainSources.provider, "slack_bot"),
              eq(brainSources.enabled, true),
            ),
          );
        destinationCount = Number(row?.value ?? 0);
      }
      return {
        isAdmin: actor.role === "admin",
        configured: isSlackBotConfigured(),
        installed,
        status:
          integration && integration.status !== "disconnected"
            ? integration.status
            : "not_connected",
        needsScopeUpgrade: Boolean(
          integration &&
            installed &&
            integration.status === "connected" &&
            !slackBotScopesSatisfied(integration.scopes),
        ),
        teamName: integration?.connectionLabel ?? null,
        statusReason: integration?.statusReason ?? null,
        destinationCount,
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
      await markIntegrationStatus({
        userWorkosId: integration.userWorkosId,
        integrationId: integration.id,
        provider: "slack_bot",
        status: "disconnected",
        statusReason: "Disconnected by a workspace admin.",
        db,
      });
    },

    async getDestination(actor, brainId) {
      const access = await getBrainAccess(
        { userWorkosId: actor.userId, brainRef: brainId },
        { db },
      );
      if (!access || access.brain.workspaceId !== actor.workspaceId) {
        throw new ApiError(404, "not_found", "Brain not found.");
      }
      const integration = await integrationFor(actor);
      const installed = Boolean(integration && integration.status !== "disconnected");
      let source: SlackBotDestination["source"] = null;
      if (integration) {
        const [row] = await db
          .select({ enabled: brainSources.enabled, config: brainSources.config })
          .from(brainSources)
          .where(
            and(eq(brainSources.brainId, brainId), eq(brainSources.integrationId, integration.id)),
          )
          .limit(1);
        if (row) {
          const config = parseSlackBrainSourceConfig(row.config);
          source = { enabled: row.enabled, channels: config.channels ?? [] };
        }
      }
      return {
        installed,
        botConnected: integration?.status === "connected",
        isAdmin: actor.role === "admin",
        brainVisibility: access.brain.visibility,
        source,
      };
    },

    async listChannels(actor, brainId) {
      await requireAdminBrain(actor, brainId);
      const token = await workspaceBotToken(actor);
      if (!token) {
        throw new ApiError(409, "conflict", "Connect the Slack bot in workspace settings first.");
      }
      const channels: SlackBotChannel[] = [];
      let cursor: string | undefined;
      let partial = false;
      let loadedPages = 0;
      try {
        do {
          const page = await request<{
            channels?: Array<{
              id?: string;
              name?: string;
              is_private?: boolean;
              is_archived?: boolean;
              is_member?: boolean;
            }>;
            response_metadata?: { next_cursor?: string };
          }>({
            method: "conversations.list",
            token,
            form: {
              types: "public_channel,private_channel",
              exclude_archived: "true",
              limit: "200",
              ...(cursor ? { cursor } : {}),
            },
          });
          loadedPages += 1;
          for (const channel of page.channels ?? []) {
            if (!channel.id || channel.is_archived) continue;
            if (channels.length >= SLACK_BOT_CHANNEL_LIMIT) {
              partial = true;
              break;
            }
            channels.push({
              id: channel.id,
              name: channel.name ?? channel.id,
              isPrivate: channel.is_private ?? false,
              isMember: channel.is_member ?? false,
            });
          }
          const nextCursor = page.response_metadata?.next_cursor || undefined;
          if (channels.length >= SLACK_BOT_CHANNEL_LIMIT && nextCursor) partial = true;
          cursor = partial ? undefined : nextCursor;
        } while (cursor);
      } catch {
        if (loadedPages === 0) {
          throw new ApiError(
            502,
            "upstream_error",
            "Could not load channels from Slack. Please try again.",
            true,
          );
        }
        partial = true;
      }
      channels.sort((a, b) => a.name.localeCompare(b.name));
      return { channels, partial };
    },

    async setDestination(actor, brainId, command) {
      await requireAdminBrain(actor, brainId);
      const integration = await integrationFor(actor);
      if (!integration || integration.status === "disconnected") {
        throw new ApiError(409, "conflict", "Connect the Slack bot in workspace settings first.");
      }
      const result = await upsertBrainSource({
        brainRef: brainId,
        provider: "slack_bot",
        integrationId: integration.id,
        userWorkosId: integration.userWorkosId,
        createdByWorkosId: actor.userId,
        enabled: command.enabled,
        config: { channels: sanitizeChannelRefs(command.channels) },
        db,
      });
      if (result.created && command.enabled) {
        await captureProductServerEvent("brain_source_added", actor.userId, {
          workspace_id: actor.workspaceId,
          brain_id: brainId,
          provider: "slack_bot",
        });
      }
    },
  };
}

function sanitizeChannelRefs(refs: SlackConversationRef[]): SlackConversationRef[] {
  const seen = new Set<string>();
  const sanitized: SlackConversationRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof ref.name === "string" ? ref.name.trim() : "";
    sanitized.push({ id, name: name || id });
  }
  return sanitized;
}
