"use server";

import { getDb } from "@opencompany/db/client";
import { upsertGoatBrainSource } from "@opencompany/db/goat-brain-sources";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
} from "@opencompany/db/goat-integrations";
import { goatBrainSources } from "@opencompany/db/goat-schema";
import type { GoatSlackConversationRef } from "@opencompany/db/goat-slack";
import { parseGoatSlackBrainSourceConfig } from "@opencompany/db/goat-slack";
import { getGoatSlackBotIntegrationForWorkspace } from "@opencompany/db/goat-slack-bot";
import { getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { slackApiRequest } from "@/lib/integrations/slack";
import type { GoatWorkspaceActionResult } from "@/lib/workspace-actions";

export type GoatSlackBotWorkspaceState = {
  installed: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  teamName: string | null;
  statusReason: string | null;
};

export type GoatSlackBotChannel = GoatSlackConversationRef & {
  isPrivate: boolean;
  isMember: boolean;
};

export type GoatSlackBotChannelListResult =
  | { ok: true; channels: GoatSlackBotChannel[]; partial: boolean }
  | { ok: false; error: string };

export type GoatSlackBotDestinationView = {
  installed: boolean;
  botConnected: boolean;
  isAdmin: boolean;
  brainVisibility: "workspace" | "restricted";
  source: { enabled: boolean; channels: GoatSlackConversationRef[] } | null;
};

export async function disconnectGoatSlackBotAction(): Promise<GoatWorkspaceActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage the Slack bot." };
  }
  const integration = await getGoatSlackBotIntegrationForWorkspace(context.workspace.id);
  if (!integration) {
    return { ok: false, error: "The Slack bot is not connected." };
  }
  try {
    await markGoatIntegrationStatus({
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
export async function listGoatSlackBotChannelsAction(
  brainRef: string,
): Promise<GoatSlackBotChannelListResult> {
  const context = await requireAdminBrainAccess(brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure the Slack bot." };
  }
  const botToken = await loadWorkspaceBotToken(context.workspace.id);
  if (!botToken) {
    return { ok: false, error: "Connect the Slack bot in workspace settings first." };
  }

  const channels: GoatSlackBotChannel[] = [];
  let cursor: string | undefined;
  let partial = false;

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
    // Rate limits or transient Slack errors: return what we have so the picker
    // stays usable instead of failing outright.
    partial = true;
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels, partial };
}

export async function getGoatBrainSlackBotDestinationAction(
  brainRef: string,
): Promise<GoatSlackBotDestinationView | null> {
  const context = await currentGoatUser();
  const access = await getGoatBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;

  const integration = await getGoatSlackBotIntegrationForWorkspace(context.workspace.id);
  const installed = Boolean(integration && integration.status !== "disconnected");

  let source: GoatSlackBotDestinationView["source"] = null;
  if (integration) {
    const [row] = await getDb()
      .select({ enabled: goatBrainSources.enabled, config: goatBrainSources.config })
      .from(goatBrainSources)
      .where(
        and(
          eq(goatBrainSources.brainId, brainRef),
          eq(goatBrainSources.integrationId, integration.id),
        ),
      )
      .limit(1);
    if (row) {
      const config = parseGoatSlackBrainSourceConfig(row.config);
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

export async function setGoatBrainSlackBotDestinationAction(input: {
  brainRef: string;
  enabled: boolean;
  channels: GoatSlackConversationRef[];
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireAdminBrainAccess(input.brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure the Slack bot." };
  }
  const integration = await getGoatSlackBotIntegrationForWorkspace(context.workspace.id);
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect the Slack bot in workspace settings first." };
  }

  try {
    await upsertGoatBrainSource({
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
  const context = await currentGoatUser();
  if (context.role !== "admin") return null;
  const access = await getGoatBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;
  return context;
}

async function loadWorkspaceBotToken(workspaceId: string): Promise<string | null> {
  const integration = await getGoatSlackBotIntegrationForWorkspace(workspaceId);
  if (!integration || integration.status === "disconnected") return null;
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: "slack_bot",
    kind: "oauth_token",
  }).catch(() => null);
  const token = credential?.payload.access_token;
  return typeof token === "string" && token ? token : null;
}

function sanitizeChannelRefs(refs: GoatSlackConversationRef[]): GoatSlackConversationRef[] {
  const seen = new Set<string>();
  const sanitized: GoatSlackConversationRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof ref.name === "string" ? ref.name.trim() : "";
    sanitized.push({ id, name: name || id });
  }
  return sanitized;
}
