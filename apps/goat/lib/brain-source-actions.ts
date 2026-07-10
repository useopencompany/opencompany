"use server";

import { getDb } from "@opencompany/db/client";
import {
  hasAnyBrainSourceForIntegration,
  listGoatBrainSourcesForBrain,
  upsertGoatBrainSource,
} from "@opencompany/db/goat-brain-sources";
import {
  type GoatGitHubRepositoryRef,
  listGoatGitHubIntegrationRepositories,
} from "@opencompany/db/goat-github";
import {
  GOAT_GMAIL_EVENT_TYPES,
  type GoatGmailEventRef,
  type GoatGmailEventType,
  sanitizeGoatGmailInstructions,
} from "@opencompany/db/goat-gmail";
import { loadGoatIntegrationCredential } from "@opencompany/db/goat-integrations";
import {
  GOAT_LINEAR_EVENT_TYPES,
  GOAT_LINEAR_MCP_EXTERNAL_ID,
  type GoatLinearEventRef,
  type GoatLinearEventType,
  type GoatLinearTeamRef,
} from "@opencompany/db/goat-linear";
import {
  type GoatBrainSourceConfigProvider,
  type GoatIntegrationProvider,
  type GoatIntegrationStatus,
  goatIntegrations,
} from "@opencompany/db/goat-schema";
import type { GoatSlackConversationRef } from "@opencompany/db/goat-slack";
import { getDefaultGoatBrainForUser, getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { GITHUB_ACTIVITY_EVENT_TYPES, type GitHubActivityEventType } from "@opencompany/goat-brain";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import type {
  GoatGmailSourceProviderState,
  GoatJamieProviderState,
  GoatLinearSourceProviderState,
  GoatSlackProviderState,
} from "@/lib/integration-state";
import {
  type GoatGitHubProviderState,
  getGoatGitHubIntegrationState,
} from "@/lib/integrations/github";
import { getGoatGmailSourceIntegrationState } from "@/lib/integrations/google-data";
import { getGoatJamieIntegrationState } from "@/lib/integrations/jamie";
import {
  getGoatLinearSourceIntegrationState,
  linearGraphqlRequest,
} from "@/lib/integrations/linear-ingest";
import { getGoatSlackIntegrationState, slackApiRequest } from "@/lib/integrations/slack";
import type { GoatWorkspaceActionResult } from "@/lib/workspace-actions";

export type GoatBrainSourceView = {
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  enabled: boolean;
  connectedByName: string;
  isOwnIntegration: boolean;
  integrationStatus: GoatIntegrationStatus;
  config: Record<string, unknown>;
};

export type GoatBrainSourcesDetails = {
  sources: GoatBrainSourceView[];
  jamie: {
    integration: GoatJamieProviderState;
    // No explicit per-brain rows exist yet for the user's Jamie integration, so
    // deliveries still follow the legacy default-brain routing.
    legacyDefaultDelivery: boolean;
    // This brain is the acting user's default brain (the legacy delivery target).
    isDefaultBrain: boolean;
  };
  slack: {
    integration: GoatSlackProviderState;
  };
  linear: {
    integration: GoatLinearSourceProviderState;
  };
  github: {
    integration: GoatGitHubProviderState;
  };
  gmail: {
    integration: GoatGmailSourceProviderState;
  };
};

function integrationProviderFor(
  provider: GoatBrainSourceConfigProvider,
): GoatIntegrationProvider | null {
  switch (provider) {
    case "jamie":
    case "gmail":
    case "github":
    case "slack":
    case "linear":
      return provider;
    default:
      return null;
  }
}

async function requireAdminBrainContext(brainRef: string) {
  const context = await currentGoatUser();
  if (context.role !== "admin") return null;
  const access = await getGoatBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;
  return context;
}

export async function getGoatBrainSourcesAction(
  brainRef: string,
): Promise<GoatBrainSourcesDetails | null> {
  const context = await requireAdminBrainContext(brainRef);
  if (!context) return null;

  const [sources, jamieState, slackState, linearState, githubState, gmailState, defaultBrain] =
    await Promise.all([
      listGoatBrainSourcesForBrain(brainRef),
      getGoatJamieIntegrationState(context.user.workosUserId),
      getGoatSlackIntegrationState(context.user.workosUserId),
      getGoatLinearSourceIntegrationState(context.user.workosUserId),
      getGoatGitHubIntegrationState(context.user.workosUserId),
      getGoatGmailSourceIntegrationState(context.user.workosUserId),
      getDefaultGoatBrainForUser(context.user.workosUserId),
    ]);

  const jamieConfigured = jamieState.integrationId
    ? await hasAnyBrainSourceForIntegration(jamieState.integrationId)
    : false;

  return {
    sources: sources.map((source) => ({
      provider: source.provider,
      integrationId: source.integrationId,
      enabled: source.enabled,
      connectedByName: source.ownerName ?? source.ownerEmail ?? "Unknown",
      isOwnIntegration: source.userWorkosId === context.user.workosUserId,
      integrationStatus: source.integrationStatus,
      config: source.config,
    })),
    jamie: {
      integration: jamieState,
      legacyDefaultDelivery: jamieState.connected && !jamieConfigured,
      isDefaultBrain: defaultBrain?.id === brainRef,
    },
    slack: {
      integration: slackState,
    },
    linear: {
      integration: linearState,
    },
    github: {
      integration: githubState,
    },
    gmail: {
      integration: gmailState,
    },
  };
}

export async function setGoatBrainSourceEnabledAction(input: {
  brainRef: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  enabled: boolean;
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireAdminBrainContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure brain sources." };
  }

  // Source providers without a matching integration provider cannot be
  // configured yet.
  const integrationProvider = integrationProviderFor(input.provider);
  if (!integrationProvider) {
    return { ok: false, error: "This source is not available yet." };
  }

  const [integration] = await getDb()
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.userWorkosId, context.user.workosUserId),
        eq(goatIntegrations.provider, integrationProvider),
        // Provider "linear" also covers the MCP connector row; only the
        // ingestion connection (keyed on the organization id) can feed brains.
        ...(integrationProvider === "linear"
          ? [ne(goatIntegrations.externalId, GOAT_LINEAR_MCP_EXTERNAL_ID)]
          : []),
      ),
    )
    .limit(1);
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect this integration in your settings first." };
  }

  try {
    const hadExplicitConfig = await hasAnyBrainSourceForIntegration(input.integrationId);

    // First explicit row for this integration ends the legacy default-brain
    // routing; materialize the default brain's row so delivery there doesn't
    // silently stop. Only Jamie ever had that implicit routing.
    if (!hadExplicitConfig && input.provider === "jamie") {
      const defaultBrain = await getDefaultGoatBrainForUser(context.user.workosUserId);
      if (defaultBrain && defaultBrain.id !== input.brainRef) {
        await upsertGoatBrainSource({
          brainRef: defaultBrain.id,
          provider: input.provider,
          integrationId: input.integrationId,
          userWorkosId: context.user.workosUserId,
          createdByWorkosId: context.user.workosUserId,
          enabled: true,
        });
      }
    }

    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: input.provider,
      integrationId: input.integrationId,
      userWorkosId: context.user.workosUserId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the brain source.",
    };
  }
}

export type GoatSlackConversationListResult =
  | {
      ok: true;
      channels: Array<GoatSlackConversationRef & { isPrivate: boolean }>;
      dms: GoatSlackConversationRef[];
      partial: boolean;
    }
  | { ok: false; error: string };

type SlackConversation = {
  id?: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
};

export async function listGoatSlackConversationsAction(
  integrationId: string,
): Promise<GoatSlackConversationListResult> {
  const context = await currentGoatUser();
  const token = await loadOwnSlackAccessToken(context.user.workosUserId, integrationId);
  if (!token) {
    return { ok: false, error: "Connect Slack in your settings first." };
  }

  const channels: Array<GoatSlackConversationRef & { isPrivate: boolean }> = [];
  const dms: GoatSlackConversationRef[] = [];
  const imUserIds: { conversationId: string; slackUserId: string }[] = [];
  let cursor: string | undefined;
  let partial = false;

  try {
    do {
      const page = await slackApiRequest<{
        channels?: SlackConversation[];
        response_metadata?: { next_cursor?: string };
      }>({
        method: "users.conversations",
        token,
        form: {
          types: "public_channel,private_channel,mpim,im",
          exclude_archived: "true",
          limit: "200",
          ...(cursor ? { cursor } : {}),
        },
      });
      for (const conversation of page.channels ?? []) {
        if (!conversation.id || conversation.is_archived) continue;
        if (conversation.is_im) {
          if (conversation.user) {
            imUserIds.push({ conversationId: conversation.id, slackUserId: conversation.user });
          }
        } else if (conversation.is_mpim) {
          dms.push({ id: conversation.id, name: conversation.name ?? conversation.id });
        } else {
          channels.push({
            id: conversation.id,
            name: conversation.name ?? conversation.id,
            isPrivate: conversation.is_private ?? false,
          });
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    // Rate limits or transient Slack errors: return what we have so the picker
    // stays usable instead of failing outright.
    partial = true;
  }

  // Resolve DM counterpart names; failures degrade to raw user ids.
  for (const im of imUserIds) {
    try {
      const result = await slackApiRequest<{ user?: { real_name?: string; name?: string } }>({
        method: "users.info",
        token,
        form: { user: im.slackUserId },
      });
      dms.push({
        id: im.conversationId,
        name: result.user?.real_name?.trim() || result.user?.name?.trim() || im.slackUserId,
      });
    } catch {
      dms.push({ id: im.conversationId, name: im.slackUserId });
      partial = true;
    }
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  dms.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels, dms, partial };
}

export async function setGoatBrainSlackSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  channels: GoatSlackConversationRef[];
  dms: GoatSlackConversationRef[];
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireAdminBrainContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure brain sources." };
  }

  const [integration] = await getDb()
    .select({ id: goatIntegrations.id, status: goatIntegrations.status })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.userWorkosId, context.user.workosUserId),
        eq(goatIntegrations.provider, "slack"),
      ),
    )
    .limit(1);
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect Slack in your settings first." };
  }

  try {
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "slack",
      integrationId: input.integrationId,
      userWorkosId: context.user.workosUserId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
      config: {
        channels: sanitizeConversationRefs(input.channels),
        dms: sanitizeConversationRefs(input.dms),
      },
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the Slack source.",
    };
  }
}

export type GoatLinearTeamListResult =
  | { ok: true; teams: GoatLinearTeamRef[]; partial: boolean }
  | { ok: false; error: string };

export async function listGoatLinearTeamsAction(
  integrationId: string,
): Promise<GoatLinearTeamListResult> {
  const context = await currentGoatUser();
  const token = await loadOwnLinearAccessToken(context.user.workosUserId, integrationId);
  if (!token) {
    return { ok: false, error: "Connect Linear in your settings first." };
  }

  const teams: GoatLinearTeamRef[] = [];
  let cursor: string | undefined;
  let partial = false;

  try {
    do {
      const page = await linearGraphqlRequest<{
        teams?: {
          nodes?: Array<{ id?: string; key?: string; name?: string }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      }>({
        token,
        query: `query GoatLinearTeams($after: String) {
          teams(first: 100, after: $after) {
            nodes { id key name }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: cursor ? { after: cursor } : {},
      });
      for (const team of page.teams?.nodes ?? []) {
        if (!team.id) continue;
        teams.push({
          id: team.id,
          name: team.name?.trim() || team.key?.trim() || team.id,
          ...(team.key?.trim() ? { key: team.key.trim() } : {}),
        });
      }
      cursor = page.teams?.pageInfo?.hasNextPage
        ? (page.teams.pageInfo.endCursor ?? undefined)
        : undefined;
    } while (cursor);
  } catch {
    // Rate limits or transient Linear errors: return what we have so the
    // picker stays usable instead of failing outright.
    partial = true;
  }

  teams.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, teams, partial };
}

export async function setGoatBrainLinearSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  teams: GoatLinearTeamRef[];
  events: GoatLinearEventRef[];
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireAdminBrainContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure brain sources." };
  }

  const [integration] = await getDb()
    .select({ id: goatIntegrations.id, status: goatIntegrations.status })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.userWorkosId, context.user.workosUserId),
        eq(goatIntegrations.provider, "linear"),
        ne(goatIntegrations.externalId, GOAT_LINEAR_MCP_EXTERNAL_ID),
      ),
    )
    .limit(1);
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect Linear in your settings first." };
  }

  try {
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "linear",
      integrationId: input.integrationId,
      userWorkosId: context.user.workosUserId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
      config: {
        teams: sanitizeTeamRefs(input.teams),
        events: sanitizeLinearEventRefs(input.events),
      },
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the Linear source.",
    };
  }
}

export type GoatGitHubRepositoryListResult =
  | { ok: true; repos: Array<GoatGitHubRepositoryRef & { private: boolean }> }
  | { ok: false; error: string };

export async function listGoatGitHubRepositoriesAction(
  integrationId: string,
): Promise<GoatGitHubRepositoryListResult> {
  const context = await currentGoatUser();
  const [integration] = await getDb()
    .select({ id: goatIntegrations.id, status: goatIntegrations.status })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, integrationId),
        eq(goatIntegrations.userWorkosId, context.user.workosUserId),
        eq(goatIntegrations.provider, "github"),
      ),
    )
    .limit(1);
  if (!integration || integration.status !== "connected") {
    return { ok: false, error: "Connect GitHub in your settings first." };
  }

  // Repositories were synced into integration resources at connect time; the
  // picker reads that catalog instead of calling GitHub.
  const repos = await listGoatGitHubIntegrationRepositories(integrationId);
  return { ok: true, repos };
}

export async function setGoatBrainGitHubSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  repos: GoatGitHubRepositoryRef[];
  events: GitHubActivityEventType[];
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireAdminBrainContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure brain sources." };
  }

  const [integration] = await getDb()
    .select({ id: goatIntegrations.id, status: goatIntegrations.status })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.userWorkosId, context.user.workosUserId),
        eq(goatIntegrations.provider, "github"),
      ),
    )
    .limit(1);
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect GitHub in your settings first." };
  }

  try {
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "github",
      integrationId: input.integrationId,
      userWorkosId: context.user.workosUserId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
      config: {
        repos: sanitizeRepositoryRefs(input.repos),
        events: sanitizeEventTypes(input.events),
      },
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the GitHub source.",
    };
  }
}

export async function setGoatBrainGmailSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  events: GoatGmailEventRef[];
  instructions: string;
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireAdminBrainContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure brain sources." };
  }

  const [integration] = await getDb()
    .select({ id: goatIntegrations.id, status: goatIntegrations.status })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.userWorkosId, context.user.workosUserId),
        eq(goatIntegrations.provider, "gmail"),
      ),
    )
    .limit(1);
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect Gmail in your settings first." };
  }

  try {
    const instructions = sanitizeGoatGmailInstructions(input.instructions);
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "gmail",
      integrationId: input.integrationId,
      userWorkosId: context.user.workosUserId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
      config: {
        events: sanitizeGmailEventRefs(input.events),
        ...(instructions ? { instructions } : {}),
      },
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the Gmail source.",
    };
  }
}

function sanitizeGmailEventRefs(refs: GoatGmailEventRef[]): GoatGmailEventRef[] {
  const allowed = new Set<GoatGmailEventType>(GOAT_GMAIL_EVENT_TYPES);
  const seen = new Set<GoatGmailEventType>();
  const sanitized: GoatGmailEventRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id as GoatGmailEventType) || seen.has(id as GoatGmailEventType)) continue;
    seen.add(id as GoatGmailEventType);
    sanitized.push({ id: id as GoatGmailEventType });
  }
  return sanitized;
}

async function loadOwnLinearAccessToken(userWorkosId: string, integrationId: string) {
  const [integration] = await getDb()
    .select({ id: goatIntegrations.id, status: goatIntegrations.status })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "linear"),
        ne(goatIntegrations.externalId, GOAT_LINEAR_MCP_EXTERNAL_ID),
      ),
    )
    .limit(1);
  if (!integration || integration.status !== "connected") return null;

  const credential = await loadGoatIntegrationCredential({
    userWorkosId,
    integrationId,
    provider: "linear",
    kind: "oauth_token",
  }).catch(() => null);
  const token = credential?.payload.access_token;
  return typeof token === "string" && token ? token : null;
}

function sanitizeTeamRefs(refs: GoatLinearTeamRef[]): GoatLinearTeamRef[] {
  const seen = new Set<string>();
  const sanitized: GoatLinearTeamRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof ref.name === "string" ? ref.name.trim() : "";
    const key = typeof ref.key === "string" ? ref.key.trim() : "";
    sanitized.push({ id, name: name || id, ...(key ? { key } : {}) });
  }
  return sanitized;
}

function sanitizeLinearEventRefs(refs: GoatLinearEventRef[]): GoatLinearEventRef[] {
  const allowed = new Set<GoatLinearEventType>(GOAT_LINEAR_EVENT_TYPES);
  const seen = new Set<GoatLinearEventType>();
  const sanitized: GoatLinearEventRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id as GoatLinearEventType) || seen.has(id as GoatLinearEventType)) continue;
    seen.add(id as GoatLinearEventType);
    sanitized.push({ id: id as GoatLinearEventType });
  }
  return sanitized;
}

function sanitizeEventTypes(events: GitHubActivityEventType[]): GitHubActivityEventType[] {
  const known = new Set<string>(GITHUB_ACTIVITY_EVENT_TYPES);
  return [...new Set(events)].filter((event) => known.has(event));
}

function sanitizeRepositoryRefs(refs: GoatGitHubRepositoryRef[]): GoatGitHubRepositoryRef[] {
  const seen = new Set<string>();
  const sanitized: GoatGitHubRepositoryRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fullName = typeof ref.fullName === "string" ? ref.fullName.trim() : "";
    sanitized.push({ id, fullName: fullName || id });
  }
  return sanitized;
}

async function loadOwnSlackAccessToken(userWorkosId: string, integrationId: string) {
  const [integration] = await getDb()
    .select({ id: goatIntegrations.id, status: goatIntegrations.status })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "slack"),
      ),
    )
    .limit(1);
  if (!integration || integration.status !== "connected") return null;

  const credential = await loadGoatIntegrationCredential({
    userWorkosId,
    integrationId,
    provider: "slack",
    kind: "oauth_token",
  }).catch(() => null);
  const token = credential?.payload.access_token;
  return typeof token === "string" && token ? token : null;
}

function sanitizeConversationRefs(refs: GoatSlackConversationRef[]): GoatSlackConversationRef[] {
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
