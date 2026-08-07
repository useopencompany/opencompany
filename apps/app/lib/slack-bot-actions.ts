"use server";

import { slackApiRequest } from "@opencompany/core/integrations/slack";
import { getDb } from "@opencompany/db/client";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import { brainSources } from "@opencompany/db/schema";
import type { SlackConversationRef } from "@opencompany/db/slack";
import { parseSlackBrainSourceConfig } from "@opencompany/db/slack";
import { getSlackBotIntegrationForWorkspace } from "@opencompany/db/slack-bot";
import { getBrainAccess } from "@opencompany/db/workspaces";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { upsertBrainSourceWithAnalytics } from "@/lib/brain-source-analytics";
import type { WorkspaceActionResult } from "@/lib/workspace-actions";

export type SlackBotWorkspaceState = {
  installed: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  teamName: string | null;
  statusReason: string | null;
};

export type SlackBotChannel = SlackConversationRef & {
  isPrivate: boolean;
  isMember: boolean;
};

export type SlackBotChannelListResult =
  | { ok: true; channels: SlackBotChannel[]; partial: boolean }
  | { ok: false; error: string };

export type SlackBotDestinationView = {
  installed: boolean;
  botConnected: boolean;
  isAdmin: boolean;
  brainVisibility: "workspace" | "restricted";
  source: { enabled: boolean; channels: SlackConversationRef[] } | null;
};

export async function disconnectSlackBotAction(): Promise<WorkspaceActionResult> {
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage the Slack bot." };
  }
  const integration = await getSlackBotIntegrationForWorkspace(context.workspace.id);
  if (!integration) {
    return { ok: false, error: "The Slack bot is not connected." };
  }
  try {
    await markIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: "slack_bot",
      status: "disconnected",
      statusReason: "Disconnected by a workspace admin.",
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not disconnect the Slack bot.",
    };
  }
}

// Channel picker source: pages conversations.list with the workspace bot
// token (unlike ingestion's per-user users.conversations).
export async function listSlackBotChannelsAction(
  brainRef: string,
): Promise<SlackBotChannelListResult> {
  const context = await requireAdminBrainAccess(brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure the Slack bot." };
  }
  const botToken = await loadWorkspaceBotToken(context.workspace.id);
  if (!botToken) {
    return { ok: false, error: "Connect the Slack bot in workspace settings first." };
  }

  const channels: SlackBotChannel[] = [];
  let cursor: string | undefined;
  let partial = false;
  let loadedPages = 0;

  try {
    do {
      const page = await slackApiRequest<{
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
        token: botToken,
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
        channels.push({
          id: channel.id,
          name: channel.name ?? channel.id,
          isPrivate: channel.is_private ?? false,
          isMember: channel.is_member ?? false,
        });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    if (loadedPages === 0) {
      return { ok: false, error: "Could not load channels from Slack. Please try again." };
    }
    // Rate limits or transient Slack errors: return what we have so the picker
    // stays usable instead of failing outright.
    partial = true;
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels, partial };
}

export async function getBrainSlackBotDestinationAction(
  brainRef: string,
): Promise<SlackBotDestinationView | null> {
  const context = await currentUser();
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;

  const integration = await getSlackBotIntegrationForWorkspace(context.workspace.id);
  const installed = Boolean(integration && integration.status !== "disconnected");

  let source: SlackBotDestinationView["source"] = null;
  if (integration) {
    const [row] = await getDb()
      .select({ enabled: brainSources.enabled, config: brainSources.config })
      .from(brainSources)
      .where(
        and(eq(brainSources.brainId, brainRef), eq(brainSources.integrationId, integration.id)),
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
    isAdmin: context.role === "admin",
    brainVisibility: access.brain.visibility,
    source,
  };
}

export async function setBrainSlackBotDestinationAction(input: {
  brainRef: string;
  enabled: boolean;
  channels: SlackConversationRef[];
}): Promise<WorkspaceActionResult> {
  const context = await requireAdminBrainAccess(input.brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure the Slack bot." };
  }
  const integration = await getSlackBotIntegrationForWorkspace(context.workspace.id);
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect the Slack bot in workspace settings first." };
  }

  try {
    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
      brainRef: input.brainRef,
      provider: "slack_bot",
      integrationId: integration.id,
      userWorkosId: integration.userWorkosId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
      config: { channels: sanitizeChannelRefs(input.channels) },
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the Slack bot destination.",
    };
  }
}

async function requireAdminBrainAccess(brainRef: string) {
  const context = await currentUser();
  if (context.role !== "admin") return null;
  const access = await getBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;
  return context;
}

async function loadWorkspaceBotToken(workspaceId: string): Promise<string | null> {
  const integration = await getSlackBotIntegrationForWorkspace(workspaceId);
  if (!integration || integration.status === "disconnected") return null;
  const credential = await loadIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: "slack_bot",
    kind: "oauth_token",
  }).catch(() => null);
  const token = credential?.payload.access_token;
  return typeof token === "string" && token ? token : null;
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
