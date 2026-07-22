"use server";

import { getDb } from "@opencompany/db/client";
import {
  GOAT_ATTIO_EVENT_TYPES,
  type GoatAttioEventRef,
  type GoatAttioEventType,
  type GoatAttioObjectTypeRef,
  isGoatAttioObjectType,
} from "@opencompany/db/goat-attio";
import {
  deleteGoatBrainSource,
  hasAnyBrainSourceForIntegration,
  listGoatBrainSourcesForBrain,
  listGoatPersonalIntegrationAccounts,
  setGoatBrainSourceEnabled,
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
import {
  GOAT_GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  type GoatGoogleDriveAllFilesRef,
  type GoatGoogleDriveCorpusKey,
  type GoatGoogleDriveResourceRef,
  readGoatGoogleDriveAllFiles,
  readGoatGoogleDriveResources,
  upsertGoatGoogleDriveSyncCursor,
} from "@opencompany/db/goat-google-drive";
import {
  GOAT_HUBSPOT_EVENT_TYPES,
  type GoatHubspotEventRef,
  type GoatHubspotEventType,
  type GoatHubspotObjectTypeRef,
  isGoatHubspotObjectType,
} from "@opencompany/db/goat-hubspot";
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
  goatBrainSources,
  goatIntegrations,
  isWorkspaceOwnedGoatIntegrationProvider,
} from "@opencompany/db/goat-schema";
import type { GoatSlackConversationRef } from "@opencompany/db/goat-slack";
import { getDefaultGoatBrainForUser, getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { GITHUB_ACTIVITY_EVENT_TYPES, type GitHubActivityEventType } from "@opencompany/goat-brain";
import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import type {
  GoatAttioProviderState,
  GoatFathomProviderState,
  GoatGmailSourceProviderState,
  GoatGoogleDriveSourceProviderState,
  GoatGranolaProviderState,
  GoatHubspotSourceProviderState,
  GoatJamieProviderState,
  GoatLinearSourceProviderState,
  GoatSlackProviderState,
} from "@/lib/integration-state";
import { getGoatAttioIntegrationState } from "@/lib/integrations/attio";
import { getGoatFathomIntegrationState } from "@/lib/integrations/fathom";
import {
  type GoatGitHubProviderState,
  getGoatGitHubIntegrationState,
} from "@/lib/integrations/github";
import {
  getGoatGmailSourceIntegrationState,
  getGoatGoogleDriveSourceIntegrationState,
} from "@/lib/integrations/google-data";
import {
  GoatGoogleDriveRequestError,
  getGoatGoogleDriveFile,
  getGoatGoogleDriveStartPageToken,
  listGoatGoogleDriveFiles,
  listGoatGoogleSharedDrives,
  loadOwnGoatGoogleDriveAccount,
} from "@/lib/integrations/google-drive";
import { getGoatGranolaIntegrationState } from "@/lib/integrations/granola";
import { getGoatHubspotSourceIntegrationState } from "@/lib/integrations/hubspot-ingest";
import {
  getGoatJamieIntegrationState,
  isGoatJamieWebhookApiKeyConfigured,
} from "@/lib/integrations/jamie";
import {
  getGoatLinearSourceIntegrationState,
  linearGraphqlRequest,
} from "@/lib/integrations/linear-ingest";
import { getGoatSlackIntegrationState, slackApiRequest } from "@/lib/integrations/slack";
import { triggerGoatGoogleDriveSyncWake } from "@/lib/task-runner";
import { getGoatAppUrl } from "@/lib/workos";
import type { GoatWorkspaceActionResult } from "@/lib/workspace-actions";

export type GoatBrainSourceView = {
  sourceId: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  enabled: boolean;
  connectedByName: string;
  ownerEmail: string | null;
  ownerAvatarUrl: string | null;
  // The specific account behind this source (a member can connect several
  // accounts of one provider).
  accountEmail: string | null;
  accountName: string | null;
  connectionLabel: string | null;
  // "workspace" = installation-bound connection owned by the workspace (any
  // admin manages it); "user" = a member's personal connection (only they can
  // change or rewire it).
  ownerKind: "workspace" | "user";
  // The viewer owns the backing personal integration.
  isOwn: boolean;
  // Config edits (pickers, filters, instructions) are owner-only for personal
  // sources; toggling/removing is owner-or-admin.
  canConfigure: boolean;
  canToggle: boolean;
  canRemove: boolean;
  integrationStatus: GoatIntegrationStatus;
  config: Record<string, unknown>;
};

export type GoatOwnSourceAccount = {
  integrationId: string;
  status: GoatIntegrationStatus;
  accountEmail: string | null;
  accountName: string | null;
  connectionLabel: string | null;
};

export type GoatBrainSourcesDetails = {
  viewer: { workosUserId: string; isAdmin: boolean };
  sources: GoatBrainSourceView[];
  // The viewer's connected personal accounts per provider — the pool the
  // add-source flow offers (the UI filters out accounts already on the brain).
  ownAccounts: {
    slack: GoatOwnSourceAccount[];
    linear: GoatOwnSourceAccount[];
    gmail: GoatOwnSourceAccount[];
    google_drive: GoatOwnSourceAccount[];
    hubspot: GoatOwnSourceAccount[];
    granola: GoatOwnSourceAccount[];
    fathom: GoatOwnSourceAccount[];
    attio: GoatOwnSourceAccount[];
  };
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
  googleDrive: {
    integration: GoatGoogleDriveSourceProviderState;
  };
  hubspot: {
    integration: GoatHubspotSourceProviderState;
  };
  granola: {
    integration: GoatGranolaProviderState;
  };
  fathom: {
    integration: GoatFathomProviderState;
  };
  attio: {
    integration: GoatAttioProviderState;
  };
};

function integrationProviderFor(
  provider: GoatBrainSourceConfigProvider,
): GoatIntegrationProvider | null {
  switch (provider) {
    case "jamie":
    case "gmail":
    case "google_drive":
    case "github":
    case "slack":
    case "linear":
    case "hubspot":
    case "granola":
    case "fathom":
    case "attio":
      return provider;
    default:
      return null;
  }
}

// Tier-1 gate: any workspace member with access to the brain. Source rows are
// then authorized per capability — owners configure their own personal
// sources; admins can additionally toggle/remove any source (but never edit a
// member-owned config).
async function requireBrainSourceContext(brainRef: string) {
  const context = await currentGoatUser();
  const access = await getGoatBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;
  return context;
}

// Workspace-owned providers (github, jamie) stay admin-managed end to end.
async function requireAdminBrainContext(brainRef: string) {
  const context = await requireBrainSourceContext(brainRef);
  if (!context || context.role !== "admin") return null;
  return context;
}

type AdminBrainContext = NonNullable<Awaited<ReturnType<typeof requireAdminBrainContext>>>;

// Ownership filter for integrations usable as brain sources: workspace-owned
// providers (github, jamie) are available to every admin of the workspace;
// identity-bound providers only to the member who connected them.
function sourceIntegrationOwnerWhere(
  provider: GoatIntegrationProvider,
  context: Pick<AdminBrainContext, "user" | "workspace">,
): SQL | undefined {
  return isWorkspaceOwnedGoatIntegrationProvider(provider)
    ? eq(goatIntegrations.workspaceId, context.workspace.id)
    : and(
        eq(goatIntegrations.userWorkosId, context.user.workosUserId),
        isNull(goatIntegrations.workspaceId),
      );
}

// Resolves an integration the acting admin may bind to a brain. Returns the
// row's user_workos_id because brain_sources mirrors it in a composite FK —
// for workspace-owned rows that is the original connector, not the actor.
async function loadSourceIntegrationForContext(input: {
  integrationId: string;
  provider: GoatIntegrationProvider;
  context: Pick<AdminBrainContext, "user" | "workspace">;
}) {
  const [integration] = await getDb()
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      externalId: goatIntegrations.externalId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.provider, input.provider),
        sourceIntegrationOwnerWhere(input.provider, input.context),
        // Provider "linear" also covers the MCP connector row; only the
        // ingestion connection (keyed on the organization id) can feed brains.
        ...(input.provider === "linear"
          ? [ne(goatIntegrations.externalId, GOAT_LINEAR_MCP_EXTERNAL_ID)]
          : []),
      ),
    )
    .limit(1);
  return integration ?? null;
}

type ExistingBrainSourceRow = {
  id: string;
  userWorkosId: string;
  integrationWorkspaceId: string | null;
};

async function loadExistingBrainSource(
  brainRef: string,
  integrationId: string,
): Promise<ExistingBrainSourceRow | null> {
  const [row] = await getDb()
    .select({
      id: goatBrainSources.id,
      userWorkosId: goatBrainSources.userWorkosId,
      integrationWorkspaceId: goatIntegrations.workspaceId,
    })
    .from(goatBrainSources)
    .innerJoin(goatIntegrations, eq(goatBrainSources.integrationId, goatIntegrations.id))
    .where(
      and(
        eq(goatBrainSources.brainId, brainRef),
        eq(goatBrainSources.integrationId, integrationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Per-source capability tiers: personal sources are configured by their owner
// only, while toggling/removing extends to admins (their veto over what feeds
// a shared brain). Workspace-owned sources (github, jamie) stay admin-only.
function brainSourceCapabilities(
  source: ExistingBrainSourceRow,
  context: Pick<AdminBrainContext, "user" | "workspace" | "role">,
) {
  const isAdmin = context.role === "admin";
  if (source.integrationWorkspaceId) {
    const managed = source.integrationWorkspaceId === context.workspace.id && isAdmin;
    return { canConfigure: managed, canToggle: managed, canRemove: managed };
  }
  const isOwn = source.userWorkosId === context.user.workosUserId;
  return { canConfigure: isOwn, canToggle: isOwn || isAdmin, canRemove: isOwn || isAdmin };
}

export async function removeGoatBrainSourceAction(input: {
  brainRef: string;
  integrationId: string;
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireBrainSourceContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "You don't have access to this brain." };
  }
  const existing = await loadExistingBrainSource(input.brainRef, input.integrationId);
  if (!existing) return { ok: true };
  const capabilities = brainSourceCapabilities(existing, context);
  if (!capabilities.canRemove) {
    return { ok: false, error: "Only the source owner or a workspace admin can remove this." };
  }
  try {
    await deleteGoatBrainSource({ brainRef: input.brainRef, sourceId: existing.id });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not remove the brain source.",
    };
  }
}

export async function getGoatBrainSourcesAction(
  brainRef: string,
): Promise<GoatBrainSourcesDetails | null> {
  const context = await requireBrainSourceContext(brainRef);
  if (!context) return null;
  const isAdmin = context.role === "admin";

  const [
    sources,
    jamieState,
    slackState,
    linearState,
    githubState,
    gmailState,
    googleDriveState,
    hubspotState,
    granolaState,
    fathomState,
    attioState,
    ownSlackAccounts,
    ownLinearAccounts,
    ownGmailAccounts,
    ownGoogleDriveAccounts,
    ownHubspotAccounts,
    ownGranolaAccounts,
    ownFathomAccounts,
    ownAttioAccounts,
  ] = await Promise.all([
    listGoatBrainSourcesForBrain(brainRef),
    getGoatJamieIntegrationState(context.workspace.id),
    getGoatSlackIntegrationState(context.user.workosUserId),
    getGoatLinearSourceIntegrationState(context.user.workosUserId),
    getGoatGitHubIntegrationState(context.workspace.id),
    getGoatGmailSourceIntegrationState(context.user.workosUserId),
    getGoatGoogleDriveSourceIntegrationState(context.user.workosUserId),
    getGoatHubspotSourceIntegrationState(context.user.workosUserId),
    getGoatGranolaIntegrationState(context.user.workosUserId),
    getGoatFathomIntegrationState(context.user.workosUserId),
    getGoatAttioIntegrationState(context.user.workosUserId),
    listGoatPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "slack",
    }),
    listGoatPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "linear",
      excludeExternalId: GOAT_LINEAR_MCP_EXTERNAL_ID,
    }),
    listGoatPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "gmail",
    }),
    listGoatPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "google_drive",
    }),
    listGoatPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "hubspot",
    }),
    listGoatPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "granola",
    }),
    listGoatPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "fathom",
    }),
    listGoatPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "attio",
    }),
  ]);

  const jamieConfigured = jamieState.integrationId
    ? await hasAnyBrainSourceForIntegration(jamieState.integrationId)
    : false;
  // Legacy Jamie routing delivers to the *connector's* default brain (the
  // webhook handler resolves it the same way), which may not be the actor's.
  const jamieOwnerDefaultBrain = jamieState.integrationId
    ? await getDefaultGoatBrainForIntegrationOwner(jamieState.integrationId)
    : null;

  return {
    viewer: { workosUserId: context.user.workosUserId, isAdmin },
    sources: sources.map((source) => {
      const workspaceOwned = Boolean(source.integrationWorkspaceId);
      const ownWorkspaceSource =
        workspaceOwned && source.integrationWorkspaceId === context.workspace.id;
      const isOwn = !workspaceOwned && source.userWorkosId === context.user.workosUserId;
      return {
        sourceId: source.id,
        provider: source.provider,
        integrationId: source.integrationId,
        enabled: source.enabled,
        connectedByName: source.ownerName ?? source.ownerEmail ?? "Unknown",
        ownerEmail: source.ownerEmail,
        ownerAvatarUrl: source.ownerAvatarUrl,
        accountEmail: source.integrationAccountEmail,
        accountName: source.integrationAccountName,
        connectionLabel: source.integrationConnectionLabel,
        ownerKind: workspaceOwned ? ("workspace" as const) : ("user" as const),
        isOwn,
        canConfigure: workspaceOwned ? ownWorkspaceSource && isAdmin : isOwn,
        canToggle: workspaceOwned ? ownWorkspaceSource && isAdmin : isOwn || isAdmin,
        canRemove: workspaceOwned ? ownWorkspaceSource && isAdmin : isOwn || isAdmin,
        integrationStatus: source.integrationStatus,
        config: source.config,
      };
    }),
    ownAccounts: {
      slack: ownSlackAccounts,
      linear: ownLinearAccounts,
      gmail: ownGmailAccounts,
      google_drive: ownGoogleDriveAccounts,
      hubspot: ownHubspotAccounts,
      granola: ownGranolaAccounts,
      fathom: ownFathomAccounts,
      attio: ownAttioAccounts,
    },
    jamie: {
      integration: jamieState,
      legacyDefaultDelivery: jamieState.apiKeyConfigured && !jamieConfigured,
      isDefaultBrain: jamieOwnerDefaultBrain?.id === brainRef,
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
    googleDrive: {
      integration: googleDriveState,
    },
    hubspot: {
      integration: hubspotState,
    },
    granola: {
      integration: granolaState,
    },
    fathom: {
      integration: fathomState,
    },
    attio: {
      integration: attioState,
    },
  };
}

export async function setGoatBrainSourceEnabledAction(input: {
  brainRef: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  enabled: boolean;
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireBrainSourceContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "You don't have access to this brain." };
  }

  // Source providers without a matching integration provider cannot be
  // configured yet.
  const integrationProvider = integrationProviderFor(input.provider);
  if (!integrationProvider) {
    return { ok: false, error: "This source is not available yet." };
  }

  // Toggling an existing row is owner-or-admin and must not require the actor
  // to own the integration — an admin pausing a member's source lands here.
  const existing = await loadExistingBrainSource(input.brainRef, input.integrationId);
  if (existing) {
    const capabilities = brainSourceCapabilities(existing, context);
    if (!capabilities.canToggle) {
      return { ok: false, error: "Only the source owner or a workspace admin can change this." };
    }
    try {
      await setGoatBrainSourceEnabled({
        brainRef: input.brainRef,
        sourceId: existing.id,
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

  // Creating a row: members attach their own personal connections; the
  // workspace-owned providers (github, jamie) stay admin-only.
  if (isWorkspaceOwnedGoatIntegrationProvider(integrationProvider) && context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can configure this source." };
  }
  const integration = await loadSourceIntegrationForContext({
    integrationId: input.integrationId,
    provider: integrationProvider,
    context,
  });
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect this integration in your settings first." };
  }
  if (
    input.provider === "jamie" &&
    !isGoatJamieWebhookApiKeyConfigured({
      status: integration.status,
      externalId: integration.externalId,
    })
  ) {
    return { ok: false, error: "Save the Jamie API key before adding it as a brain source." };
  }

  try {
    const hadExplicitConfig = await hasAnyBrainSourceForIntegration(input.integrationId);

    // First explicit row for this integration ends the legacy default-brain
    // routing; materialize the default brain's row so delivery there doesn't
    // silently stop. Only Jamie ever had that implicit routing, and it targets
    // the connector's default brain (the webhook resolves it the same way).
    if (!hadExplicitConfig && input.provider === "jamie") {
      const defaultBrain = await getDefaultGoatBrainForUser(integration.userWorkosId);
      if (defaultBrain && defaultBrain.id !== input.brainRef) {
        await upsertGoatBrainSource({
          brainRef: defaultBrain.id,
          provider: input.provider,
          integrationId: input.integrationId,
          userWorkosId: integration.userWorkosId,
          createdByWorkosId: context.user.workosUserId,
          enabled: true,
        });
      }
    }

    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: input.provider,
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
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
  const context = await requireBrainSourceContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "You don't have access to this brain." };
  }

  // Personal-provider config is owner-only: the where clause below resolves
  // the integration only when the actor owns it.
  const integration = await loadSourceIntegrationForContext({
    integrationId: input.integrationId,
    provider: "slack",
    context,
  });
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect Slack in your settings first." };
  }

  try {
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "slack",
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
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
  const context = await requireBrainSourceContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "You don't have access to this brain." };
  }

  const integration = await loadSourceIntegrationForContext({
    integrationId: input.integrationId,
    provider: "linear",
    context,
  });
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect Linear in your settings first." };
  }

  try {
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "linear",
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
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

export async function setGoatBrainHubspotSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  objectTypes: GoatHubspotObjectTypeRef[];
  events: GoatHubspotEventRef[];
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireBrainSourceContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "You don't have access to this brain." };
  }

  const integration = await loadSourceIntegrationForContext({
    integrationId: input.integrationId,
    provider: "hubspot",
    context,
  });
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect HubSpot in your settings first." };
  }

  try {
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "hubspot",
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
      config: {
        objectTypes: sanitizeHubspotObjectTypeRefs(input.objectTypes),
        events: sanitizeHubspotEventRefs(input.events),
      },
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the HubSpot source.",
    };
  }
}

export async function setGoatBrainAttioSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  objectTypes: GoatAttioObjectTypeRef[];
  events: GoatAttioEventRef[];
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireBrainSourceContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "You don't have access to this brain." };
  }

  const integration = await loadSourceIntegrationForContext({
    integrationId: input.integrationId,
    provider: "attio",
    context,
  });
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect Attio in your settings first." };
  }

  try {
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "attio",
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
      config: {
        objectTypes: sanitizeAttioObjectTypeRefs(input.objectTypes),
        events: sanitizeAttioEventRefs(input.events),
      },
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the Attio source.",
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
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can configure brain sources." };
  }
  const integration = await loadSourceIntegrationForContext({
    integrationId,
    provider: "github",
    context,
  });
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

  const integration = await loadSourceIntegrationForContext({
    integrationId: input.integrationId,
    provider: "github",
    context,
  });
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect GitHub in your settings first." };
  }

  try {
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "github",
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
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
  const context = await requireBrainSourceContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "You don't have access to this brain." };
  }

  const integration = await loadSourceIntegrationForContext({
    integrationId: input.integrationId,
    provider: "gmail",
    context,
  });
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect Gmail in your settings first." };
  }

  try {
    const instructions = sanitizeGoatGmailInstructions(input.instructions);
    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "gmail",
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
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

export type GoatGoogleDriveResourceListResult =
  | {
      ok: true;
      files: Array<{
        id: string;
        name: string;
        kind: "file" | "folder";
        mimeType: string;
        driveId: string | null;
        webViewLink: string | null;
      }>;
      nextPageToken: string | null;
    }
  | { ok: false; error: string };

export async function listGoatGoogleDriveResourcesAction(input: {
  integrationId: string;
  parentId?: string;
  query?: string;
  pageToken?: string;
}): Promise<GoatGoogleDriveResourceListResult> {
  const context = await currentGoatUser();
  const parentId = input.parentId?.trim();
  const query = input.query?.trim();
  const pageToken = input.pageToken?.trim();
  if (
    (parentId?.length ?? 0) > 512 ||
    (query?.length ?? 0) > 200 ||
    (pageToken?.length ?? 0) > 4_096
  ) {
    return { ok: false, error: "Invalid Google Drive browse request." };
  }
  const account = await loadOwnGoatGoogleDriveAccount(
    context.user.workosUserId,
    input.integrationId,
  );
  if (!account) return { ok: false, error: "Connect Google Drive in Settings first." };
  try {
    const page = await listGoatGoogleDriveFiles({
      account,
      ...(parentId ? { parentId } : {}),
      ...(query ? { query } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    const sharedDrives =
      !parentId && !query && !pageToken ? await listGoatGoogleSharedDrives({ account }) : [];
    return {
      ok: true,
      files: [
        ...sharedDrives.map((drive) => ({
          id: drive.id,
          name: `${drive.name} (Shared Drive)`,
          kind: "folder" as const,
          mimeType: GOAT_GOOGLE_DRIVE_FOLDER_MIME_TYPE,
          driveId: drive.id,
          webViewLink: `https://drive.google.com/drive/folders/${drive.id}`,
        })),
        ...page.files.map((file) => ({
          id: file.id,
          name: file.name,
          kind:
            file.mimeType === GOAT_GOOGLE_DRIVE_FOLDER_MIME_TYPE
              ? ("folder" as const)
              : ("file" as const),
          mimeType: file.mimeType,
          driveId: file.driveId,
          webViewLink: file.webViewLink,
        })),
      ],
      nextPageToken: page.nextPageToken,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not load Google Drive files.",
    };
  }
}

export async function setGoatBrainGoogleDriveSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  allFiles?: boolean;
  resourceIds: string[];
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireBrainSourceContext(input.brainRef);
  if (!context) {
    return { ok: false, error: "You don't have access to this brain." };
  }
  const integration = await loadSourceIntegrationForContext({
    integrationId: input.integrationId,
    provider: "google_drive",
    context,
  });
  if (!integration)
    return { ok: false, error: "Only the connection owner can configure this source." };
  const resourceIds = [...new Set(input.resourceIds.map((id) => id.trim()).filter(Boolean))];
  if (resourceIds.some((id) => id.length > 512)) {
    return { ok: false, error: "Invalid Google Drive resource id." };
  }
  if (input.enabled && !input.allFiles && resourceIds.length === 0) {
    return { ok: false, error: "Select at least one Drive file or folder, or choose all files." };
  }
  if (resourceIds.length > 100) {
    return { ok: false, error: "Select at most 100 Drive files or folders per brain." };
  }

  try {
    const [existing] = await getDb()
      .select({ config: goatBrainSources.config, enabled: goatBrainSources.enabled })
      .from(goatBrainSources)
      .where(
        and(
          eq(goatBrainSources.brainId, input.brainRef),
          eq(goatBrainSources.integrationId, input.integrationId),
        ),
      )
      .limit(1);
    const existingResources = new Map(
      readGoatGoogleDriveResources(existing?.config).map((resource) => [resource.id, resource]),
    );
    const existingAllFiles = readGoatGoogleDriveAllFiles(existing?.config);

    // Disabling must remain possible after token revocation or access loss.
    // Retain only server-known resources; the editor passes an empty list when
    // the user intentionally clears the selection.
    if (!input.enabled) {
      const resources = resourceIds.flatMap((id) => existingResources.get(id) ?? []);
      const allFiles = input.allFiles ? existingAllFiles : null;
      await upsertGoatBrainSource({
        brainRef: input.brainRef,
        provider: "google_drive",
        integrationId: input.integrationId,
        userWorkosId: integration.userWorkosId,
        createdByWorkosId: context.user.workosUserId,
        enabled: false,
        config: { ...(allFiles ? { allFiles } : {}), resources },
      });
      revalidatePath("/", "layout");
      return { ok: true };
    }

    if (integration.status === "disconnected") {
      return { ok: false, error: "Reconnect Google Drive in Settings first." };
    }
    const account = await loadOwnGoatGoogleDriveAccount(
      context.user.workosUserId,
      input.integrationId,
    );
    if (!account) {
      return { ok: false, error: "Only the connection owner can configure this source." };
    }
    const files = input.allFiles
      ? []
      : await Promise.all(resourceIds.map((fileId) => getGoatGoogleDriveFile({ account, fileId })));
    if (files.some((file) => file.trashed)) {
      return { ok: false, error: "Remove trashed Drive items before saving." };
    }

    const resetSelectionTimes = Boolean(existing && !existing.enabled && input.enabled);
    const sharedDrives = input.allFiles ? await listGoatGoogleSharedDrives({ account }) : [];
    const driveIds = [
      ...new Set([
        ...files.flatMap((file) => (file.driveId ? [file.driveId] : [])),
        ...sharedDrives.map((drive) => drive.id),
      ]),
    ];
    const sharedTokens = new Map<string, string>();
    await Promise.all(
      driveIds.map(async (driveId) => {
        try {
          sharedTokens.set(driveId, await getGoatGoogleDriveStartPageToken({ account, driveId }));
        } catch (error) {
          // A directly shared file can carry a driveId without granting access
          // to that Shared Drive's change log; the user corpus tracks it.
          if (
            !(error instanceof GoatGoogleDriveRequestError) ||
            (error.status !== 403 && error.status !== 404)
          ) {
            throw error;
          }
        }
      }),
    );

    // The account-level log covers My Drive and directly shared files and is
    // always maintained alongside any selected Shared Drive logs.
    const userToken = await getGoatGoogleDriveStartPageToken({ account });
    const webhookAddress = `${getGoatAppUrl()}/api/webhooks/google-drive`;
    const cursors = new Map<GoatGoogleDriveCorpusKey, { driveId: string | null; token: string }>();
    cursors.set("user", { driveId: null, token: userToken });
    for (const [driveId, token] of sharedTokens) {
      cursors.set(`drive:${driveId}`, { driveId, token });
    }
    await Promise.all(
      [...cursors].map(([corpusKey, cursor]) =>
        upsertGoatGoogleDriveSyncCursor({
          integrationId: input.integrationId,
          userWorkosId: integration.userWorkosId,
          corpusKey,
          driveId: cursor.driveId,
          pageToken: cursor.token,
          webhookAddress,
        }),
      ),
    );

    // Tokens are durable before this timestamp is recorded. A change racing
    // token acquisition is either before selection (filtered) or after it
    // (present in the durable feed), so the no-backfill boundary has no gap.
    const selectedAt = new Date().toISOString();
    const allFiles: GoatGoogleDriveAllFilesRef | null = input.allFiles
      ? {
          selectedAt:
            !resetSelectionTimes && existingAllFiles ? existingAllFiles.selectedAt : selectedAt,
        }
      : null;
    const resources: GoatGoogleDriveResourceRef[] = files.map((file) => {
      const corpusKey: GoatGoogleDriveCorpusKey =
        file.driveId && sharedTokens.has(file.driveId) ? `drive:${file.driveId}` : "user";
      const previous = existingResources.get(file.id);
      return {
        id: file.id,
        name: file.name,
        kind: file.mimeType === GOAT_GOOGLE_DRIVE_FOLDER_MIME_TYPE ? "folder" : "file",
        mimeType: file.mimeType,
        driveId: file.driveId,
        corpusKey,
        webViewLink: file.webViewLink,
        selectedAt: !resetSelectionTimes && previous ? previous.selectedAt : selectedAt,
      };
    });

    await upsertGoatBrainSource({
      brainRef: input.brainRef,
      provider: "google_drive",
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
      createdByWorkosId: context.user.workosUserId,
      enabled: true,
      config: { ...(allFiles ? { allFiles } : {}), resources },
    });
    triggerGoatGoogleDriveSyncWake().catch((error) => {
      console.warn("Could not wake Goat Google Drive sync worker.", {
        event: "goat.google_drive_source_wake_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the Google Drive source.",
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

async function getDefaultGoatBrainForIntegrationOwner(integrationId: string) {
  const [row] = await getDb()
    .select({ userWorkosId: goatIntegrations.userWorkosId })
    .from(goatIntegrations)
    .where(eq(goatIntegrations.id, integrationId))
    .limit(1);
  if (!row) return null;
  return getDefaultGoatBrainForUser(row.userWorkosId);
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

function sanitizeHubspotObjectTypeRefs(
  refs: GoatHubspotObjectTypeRef[],
): GoatHubspotObjectTypeRef[] {
  const seen = new Set<string>();
  const sanitized: GoatHubspotObjectTypeRef[] = [];
  for (const ref of refs) {
    if (!isGoatHubspotObjectType(ref.id) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    sanitized.push({ id: ref.id });
  }
  return sanitized;
}

function sanitizeHubspotEventRefs(refs: GoatHubspotEventRef[]): GoatHubspotEventRef[] {
  const allowed = new Set<GoatHubspotEventType>(GOAT_HUBSPOT_EVENT_TYPES);
  const seen = new Set<GoatHubspotEventType>();
  const sanitized: GoatHubspotEventRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id as GoatHubspotEventType) || seen.has(id as GoatHubspotEventType)) continue;
    seen.add(id as GoatHubspotEventType);
    sanitized.push({ id: id as GoatHubspotEventType });
  }
  return sanitized;
}

function sanitizeAttioObjectTypeRefs(refs: GoatAttioObjectTypeRef[]): GoatAttioObjectTypeRef[] {
  const seen = new Set<string>();
  const sanitized: GoatAttioObjectTypeRef[] = [];
  for (const ref of refs) {
    if (!isGoatAttioObjectType(ref.id) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    sanitized.push({ id: ref.id });
  }
  return sanitized;
}

function sanitizeAttioEventRefs(refs: GoatAttioEventRef[]): GoatAttioEventRef[] {
  const allowed = new Set<GoatAttioEventType>(GOAT_ATTIO_EVENT_TYPES);
  const seen = new Set<GoatAttioEventType>();
  const sanitized: GoatAttioEventRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id as GoatAttioEventType) || seen.has(id as GoatAttioEventType)) continue;
    seen.add(id as GoatAttioEventType);
    sanitized.push({ id: id as GoatAttioEventType });
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
