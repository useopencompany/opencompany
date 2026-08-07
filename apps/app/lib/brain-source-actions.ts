"use server";

import { GITHUB_ACTIVITY_EVENT_TYPES, type GitHubActivityEventType } from "@opencompany/brain";
import {
  type AttioEventRef,
  type AttioEventType,
  type AttioObjectTypeRef,
  GOAT_ATTIO_EVENT_TYPES,
  isAttioObjectType,
} from "@opencompany/db/attio";
import {
  deleteBrainSource,
  hasAnyBrainSourceForIntegration,
  listBrainSourcesForBrain,
  listPersonalIntegrationAccounts,
  setBrainSourceEnabled,
  upsertBrainSource,
} from "@opencompany/db/brain-sources";
import { getDb } from "@opencompany/db/client";
import {
  type GitHubRepositoryRef,
  listGitHubIntegrationRepositories,
} from "@opencompany/db/github";
import {
  type GmailEventRef,
  type GmailEventType,
  GOAT_GMAIL_EVENT_TYPES,
  sanitizeGmailInstructions,
} from "@opencompany/db/gmail";
import {
  GOAT_GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  type GoogleDriveAllFilesRef,
  type GoogleDriveCorpusKey,
  type GoogleDriveResourceRef,
  readGoogleDriveAllFiles,
  readGoogleDriveResources,
  upsertGoogleDriveSyncCursor,
} from "@opencompany/db/google-drive";
import {
  HUBSPOT_EVENT_TYPES,
  type HubspotEventRef,
  type HubspotEventType,
  type HubspotObjectTypeRef,
  isHubspotObjectType,
} from "@opencompany/db/hubspot";
import { loadIntegrationCredential } from "@opencompany/db/integrations";
import {
  GOAT_LINEAR_EVENT_TYPES,
  GOAT_LINEAR_MCP_EXTERNAL_ID,
  type LinearEventRef,
  type LinearEventType,
  type LinearTeamRef,
} from "@opencompany/db/linear";
import {
  type BrainSourceConfigProvider,
  brainSources,
  type IntegrationProvider,
  type IntegrationStatus,
  integrations,
  isWorkspaceOwnedIntegrationProvider,
} from "@opencompany/db/schema";
import type { SlackConversationRef } from "@opencompany/db/slack";
import { getBrainAccess, getDefaultBrainForUser } from "@opencompany/db/workspaces";
import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { upsertBrainSourceWithAnalytics } from "@/lib/brain-source-analytics";
import type {
  AttioProviderState,
  FathomProviderState,
  GmailSourceProviderState,
  GoogleDriveSourceProviderState,
  GranolaProviderState,
  HubspotSourceProviderState,
  JamieProviderState,
  LinearSourceProviderState,
  SlackProviderState,
} from "@/lib/integration-state";
import { getAttioIntegrationState } from "@/lib/integrations/attio";
import { getFathomIntegrationState } from "@/lib/integrations/fathom";
import { type GitHubProviderState, getGitHubIntegrationState } from "@/lib/integrations/github";
import {
  getGmailSourceIntegrationState,
  getGoogleDriveSourceIntegrationState,
} from "@/lib/integrations/google-data";
import {
  GoogleDriveRequestError,
  getGoogleDriveFile,
  getGoogleDriveStartPageToken,
  listGoogleDriveFiles,
  listGoogleSharedDrives,
  loadOwnGoogleDriveAccount,
} from "@/lib/integrations/google-drive";
import { getGranolaIntegrationState } from "@/lib/integrations/granola";
import { getHubspotSourceIntegrationState } from "@/lib/integrations/hubspot-ingest";
import { getJamieIntegrationState, isJamieWebhookApiKeyConfigured } from "@/lib/integrations/jamie";
import {
  getLinearSourceIntegrationState,
  linearGraphqlRequest,
} from "@/lib/integrations/linear-ingest";
import { getSlackIntegrationState } from "@/lib/integrations/slack";
import {
  listSlackConversationOptions,
  type SlackChannelOption,
  type SlackDmOption,
} from "@/lib/integrations/slack-conversations";
import { triggerGoogleDriveSyncWake } from "@/lib/task-runner";
import { getAppUrl } from "@/lib/workos";
import type { WorkspaceActionResult } from "@/lib/workspace-actions";

export type BrainSourceView = {
  sourceId: string;
  provider: BrainSourceConfigProvider;
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
  integrationStatus: IntegrationStatus;
  config: Record<string, unknown>;
};

export type OwnSourceAccount = {
  integrationId: string;
  status: IntegrationStatus;
  accountEmail: string | null;
  accountName: string | null;
  connectionLabel: string | null;
};

export type BrainSourcesDetails = {
  viewer: { workosUserId: string; isAdmin: boolean };
  sources: BrainSourceView[];
  // The viewer's connected personal accounts per provider — the pool the
  // add-source flow offers (the UI filters out accounts already on the brain).
  ownAccounts: {
    slack: OwnSourceAccount[];
    linear: OwnSourceAccount[];
    gmail: OwnSourceAccount[];
    google_drive: OwnSourceAccount[];
    hubspot: OwnSourceAccount[];
    granola: OwnSourceAccount[];
    fathom: OwnSourceAccount[];
    attio: OwnSourceAccount[];
  };
  jamie: {
    integration: JamieProviderState;
    // No explicit per-brain rows exist yet for the user's Jamie integration, so
    // deliveries still follow the legacy default-brain routing.
    legacyDefaultDelivery: boolean;
    // This brain is the acting user's default brain (the legacy delivery target).
    isDefaultBrain: boolean;
  };
  slack: {
    integration: SlackProviderState;
  };
  linear: {
    integration: LinearSourceProviderState;
  };
  github: {
    integration: GitHubProviderState;
  };
  gmail: {
    integration: GmailSourceProviderState;
  };
  googleDrive: {
    integration: GoogleDriveSourceProviderState;
  };
  hubspot: {
    integration: HubspotSourceProviderState;
  };
  granola: {
    integration: GranolaProviderState;
  };
  fathom: {
    integration: FathomProviderState;
  };
  attio: {
    integration: AttioProviderState;
  };
};

function integrationProviderFor(provider: BrainSourceConfigProvider): IntegrationProvider | null {
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
  const context = await currentUser();
  const access = await getBrainAccess({
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
  provider: IntegrationProvider,
  context: Pick<AdminBrainContext, "user" | "workspace">,
): SQL | undefined {
  return isWorkspaceOwnedIntegrationProvider(provider)
    ? eq(integrations.workspaceId, context.workspace.id)
    : and(
        eq(integrations.userWorkosId, context.user.workosUserId),
        isNull(integrations.workspaceId),
      );
}

// Resolves an integration the acting admin may bind to a brain. Returns the
// row's user_workos_id because brain_sources mirrors it in a composite FK —
// for workspace-owned rows that is the original connector, not the actor.
async function loadSourceIntegrationForContext(input: {
  integrationId: string;
  provider: IntegrationProvider;
  context: Pick<AdminBrainContext, "user" | "workspace">;
}) {
  const [integration] = await getDb()
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      externalId: integrations.externalId,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, input.integrationId),
        eq(integrations.provider, input.provider),
        sourceIntegrationOwnerWhere(input.provider, input.context),
        // Provider "linear" also covers the MCP connector row; only the
        // ingestion connection (keyed on the organization id) can feed brains.
        ...(input.provider === "linear"
          ? [ne(integrations.externalId, GOAT_LINEAR_MCP_EXTERNAL_ID)]
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
      id: brainSources.id,
      userWorkosId: brainSources.userWorkosId,
      integrationWorkspaceId: integrations.workspaceId,
    })
    .from(brainSources)
    .innerJoin(integrations, eq(brainSources.integrationId, integrations.id))
    .where(and(eq(brainSources.brainId, brainRef), eq(brainSources.integrationId, integrationId)))
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

export async function removeBrainSourceAction(input: {
  brainRef: string;
  integrationId: string;
}): Promise<WorkspaceActionResult> {
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
    await deleteBrainSource({ brainRef: input.brainRef, sourceId: existing.id });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not remove the brain source.",
    };
  }
}

export async function getBrainSourcesAction(brainRef: string): Promise<BrainSourcesDetails | null> {
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
    listBrainSourcesForBrain(brainRef),
    getJamieIntegrationState(context.workspace.id),
    getSlackIntegrationState(context.user.workosUserId),
    getLinearSourceIntegrationState(context.user.workosUserId),
    getGitHubIntegrationState(context.workspace.id),
    getGmailSourceIntegrationState(context.user.workosUserId),
    getGoogleDriveSourceIntegrationState(context.user.workosUserId),
    getHubspotSourceIntegrationState(context.user.workosUserId),
    getGranolaIntegrationState(context.user.workosUserId),
    getFathomIntegrationState(context.user.workosUserId),
    getAttioIntegrationState(context.user.workosUserId),
    listPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "slack",
    }),
    listPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "linear",
      excludeExternalId: GOAT_LINEAR_MCP_EXTERNAL_ID,
    }),
    listPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "gmail",
    }),
    listPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "google_drive",
    }),
    listPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "hubspot",
    }),
    listPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "granola",
    }),
    listPersonalIntegrationAccounts({
      userWorkosId: context.user.workosUserId,
      provider: "fathom",
    }),
    listPersonalIntegrationAccounts({
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
    ? await getDefaultBrainForIntegrationOwner(jamieState.integrationId)
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

export async function setBrainSourceEnabledAction(input: {
  brainRef: string;
  provider: BrainSourceConfigProvider;
  integrationId: string;
  enabled: boolean;
}): Promise<WorkspaceActionResult> {
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
      await setBrainSourceEnabled({
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
  if (isWorkspaceOwnedIntegrationProvider(integrationProvider) && context.role !== "admin") {
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
    !isJamieWebhookApiKeyConfigured({
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
      const defaultBrain = await getDefaultBrainForUser(integration.userWorkosId);
      if (defaultBrain && defaultBrain.id !== input.brainRef) {
        await upsertBrainSource({
          brainRef: defaultBrain.id,
          provider: input.provider,
          integrationId: input.integrationId,
          userWorkosId: integration.userWorkosId,
          createdByWorkosId: context.user.workosUserId,
          enabled: true,
        });
      }
    }

    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
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

export type SlackConversationListResult =
  | {
      ok: true;
      channels: SlackChannelOption[];
      dms: SlackDmOption[];
      partial: boolean;
    }
  | { ok: false; error: string };

export async function listSlackConversationsAction(
  integrationId: string,
): Promise<SlackConversationListResult> {
  const context = await currentUser();
  const account = await loadOwnSlackAccount(context.user.workosUserId, integrationId);
  if (!account) {
    return { ok: false, error: "Connect Slack in your settings first." };
  }

  const options = await listSlackConversationOptions(account);
  return { ok: true, ...options };
}

export async function setBrainSlackSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  channels: SlackConversationRef[];
  dms: SlackConversationRef[];
}): Promise<WorkspaceActionResult> {
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
    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
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

export type LinearTeamListResult =
  | { ok: true; teams: LinearTeamRef[]; partial: boolean }
  | { ok: false; error: string };

export async function listLinearTeamsAction(integrationId: string): Promise<LinearTeamListResult> {
  const context = await currentUser();
  const token = await loadOwnLinearAccessToken(context.user.workosUserId, integrationId);
  if (!token) {
    return { ok: false, error: "Connect Linear in your settings first." };
  }

  const teams: LinearTeamRef[] = [];
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
        query: `query LinearTeams($after: String) {
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

export async function setBrainLinearSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  teams: LinearTeamRef[];
  events: LinearEventRef[];
}): Promise<WorkspaceActionResult> {
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
    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
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

export async function setBrainHubspotSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  objectTypes: HubspotObjectTypeRef[];
  events: HubspotEventRef[];
}): Promise<WorkspaceActionResult> {
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
    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
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

export async function setBrainAttioSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  objectTypes: AttioObjectTypeRef[];
  events: AttioEventRef[];
}): Promise<WorkspaceActionResult> {
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
    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
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

export type GitHubRepositoryListResult =
  | { ok: true; repos: Array<GitHubRepositoryRef & { private: boolean }> }
  | { ok: false; error: string };

export async function listGitHubRepositoriesAction(
  integrationId: string,
): Promise<GitHubRepositoryListResult> {
  const context = await currentUser();
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
  const repos = await listGitHubIntegrationRepositories(integrationId);
  return { ok: true, repos };
}

export async function setBrainGitHubSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  repos: GitHubRepositoryRef[];
  events: GitHubActivityEventType[];
}): Promise<WorkspaceActionResult> {
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
    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
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

export async function setBrainGmailSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  events: GmailEventRef[];
  instructions: string;
}): Promise<WorkspaceActionResult> {
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
    const instructions = sanitizeGmailInstructions(input.instructions);
    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
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

export type GoogleDriveResourceListResult =
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

export async function listGoogleDriveResourcesAction(input: {
  integrationId: string;
  parentId?: string;
  query?: string;
  pageToken?: string;
}): Promise<GoogleDriveResourceListResult> {
  const context = await currentUser();
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
  const account = await loadOwnGoogleDriveAccount(context.user.workosUserId, input.integrationId);
  if (!account) return { ok: false, error: "Connect Google Drive in Settings first." };
  try {
    const page = await listGoogleDriveFiles({
      account,
      ...(parentId ? { parentId } : {}),
      ...(query ? { query } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    const sharedDrives =
      !parentId && !query && !pageToken ? await listGoogleSharedDrives({ account }) : [];
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

export async function setBrainGoogleDriveSourceAction(input: {
  brainRef: string;
  integrationId: string;
  enabled: boolean;
  allFiles?: boolean;
  resourceIds: string[];
}): Promise<WorkspaceActionResult> {
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
      .select({ config: brainSources.config, enabled: brainSources.enabled })
      .from(brainSources)
      .where(
        and(
          eq(brainSources.brainId, input.brainRef),
          eq(brainSources.integrationId, input.integrationId),
        ),
      )
      .limit(1);
    const existingResources = new Map(
      readGoogleDriveResources(existing?.config).map((resource) => [resource.id, resource]),
    );
    const existingAllFiles = readGoogleDriveAllFiles(existing?.config);

    // Disabling must remain possible after token revocation or access loss.
    // Retain only server-known resources; the editor passes an empty list when
    // the user intentionally clears the selection.
    if (!input.enabled) {
      const resources = resourceIds.flatMap((id) => existingResources.get(id) ?? []);
      const allFiles = input.allFiles ? existingAllFiles : null;
      await upsertBrainSourceWithAnalytics({
        workspaceId: context.workspace.id,
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
    const account = await loadOwnGoogleDriveAccount(context.user.workosUserId, input.integrationId);
    if (!account) {
      return { ok: false, error: "Only the connection owner can configure this source." };
    }
    const files = input.allFiles
      ? []
      : await Promise.all(resourceIds.map((fileId) => getGoogleDriveFile({ account, fileId })));
    if (files.some((file) => file.trashed)) {
      return { ok: false, error: "Remove trashed Drive items before saving." };
    }

    const resetSelectionTimes = Boolean(existing && !existing.enabled && input.enabled);
    const sharedDrives = input.allFiles ? await listGoogleSharedDrives({ account }) : [];
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
          sharedTokens.set(driveId, await getGoogleDriveStartPageToken({ account, driveId }));
        } catch (error) {
          // A directly shared file can carry a driveId without granting access
          // to that Shared Drive's change log; the user corpus tracks it.
          if (
            !(error instanceof GoogleDriveRequestError) ||
            (error.status !== 403 && error.status !== 404)
          ) {
            throw error;
          }
        }
      }),
    );

    // The account-level log covers My Drive and directly shared files and is
    // always maintained alongside any selected Shared Drive logs.
    const userToken = await getGoogleDriveStartPageToken({ account });
    const webhookAddress = `${getAppUrl()}/api/webhooks/google-drive`;
    const cursors = new Map<GoogleDriveCorpusKey, { driveId: string | null; token: string }>();
    cursors.set("user", { driveId: null, token: userToken });
    for (const [driveId, token] of sharedTokens) {
      cursors.set(`drive:${driveId}`, { driveId, token });
    }
    await Promise.all(
      [...cursors].map(([corpusKey, cursor]) =>
        upsertGoogleDriveSyncCursor({
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
    const allFiles: GoogleDriveAllFilesRef | null = input.allFiles
      ? {
          selectedAt:
            !resetSelectionTimes && existingAllFiles ? existingAllFiles.selectedAt : selectedAt,
        }
      : null;
    const resources: GoogleDriveResourceRef[] = files.map((file) => {
      const corpusKey: GoogleDriveCorpusKey =
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

    await upsertBrainSourceWithAnalytics({
      workspaceId: context.workspace.id,
      brainRef: input.brainRef,
      provider: "google_drive",
      integrationId: input.integrationId,
      userWorkosId: integration.userWorkosId,
      createdByWorkosId: context.user.workosUserId,
      enabled: true,
      config: { ...(allFiles ? { allFiles } : {}), resources },
    });
    triggerGoogleDriveSyncWake().catch((error) => {
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

function sanitizeGmailEventRefs(refs: GmailEventRef[]): GmailEventRef[] {
  const allowed = new Set<GmailEventType>(GOAT_GMAIL_EVENT_TYPES);
  const seen = new Set<GmailEventType>();
  const sanitized: GmailEventRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id as GmailEventType) || seen.has(id as GmailEventType)) continue;
    seen.add(id as GmailEventType);
    sanitized.push({ id: id as GmailEventType });
  }
  return sanitized;
}

async function getDefaultBrainForIntegrationOwner(integrationId: string) {
  const [row] = await getDb()
    .select({ userWorkosId: integrations.userWorkosId })
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);
  if (!row) return null;
  return getDefaultBrainForUser(row.userWorkosId);
}

async function loadOwnLinearAccessToken(userWorkosId: string, integrationId: string) {
  const [integration] = await getDb()
    .select({ id: integrations.id, status: integrations.status })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, "linear"),
        ne(integrations.externalId, GOAT_LINEAR_MCP_EXTERNAL_ID),
      ),
    )
    .limit(1);
  if (!integration || integration.status !== "connected") return null;

  const credential = await loadIntegrationCredential({
    userWorkosId,
    integrationId,
    provider: "linear",
    kind: "oauth_token",
  }).catch(() => null);
  const token = credential?.payload.access_token;
  return typeof token === "string" && token ? token : null;
}

function sanitizeTeamRefs(refs: LinearTeamRef[]): LinearTeamRef[] {
  const seen = new Set<string>();
  const sanitized: LinearTeamRef[] = [];
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

function sanitizeLinearEventRefs(refs: LinearEventRef[]): LinearEventRef[] {
  const allowed = new Set<LinearEventType>(GOAT_LINEAR_EVENT_TYPES);
  const seen = new Set<LinearEventType>();
  const sanitized: LinearEventRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id as LinearEventType) || seen.has(id as LinearEventType)) continue;
    seen.add(id as LinearEventType);
    sanitized.push({ id: id as LinearEventType });
  }
  return sanitized;
}

function sanitizeHubspotObjectTypeRefs(refs: HubspotObjectTypeRef[]): HubspotObjectTypeRef[] {
  const seen = new Set<string>();
  const sanitized: HubspotObjectTypeRef[] = [];
  for (const ref of refs) {
    if (!isHubspotObjectType(ref.id) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    sanitized.push({ id: ref.id });
  }
  return sanitized;
}

function sanitizeHubspotEventRefs(refs: HubspotEventRef[]): HubspotEventRef[] {
  const allowed = new Set<HubspotEventType>(HUBSPOT_EVENT_TYPES);
  const seen = new Set<HubspotEventType>();
  const sanitized: HubspotEventRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id as HubspotEventType) || seen.has(id as HubspotEventType)) continue;
    seen.add(id as HubspotEventType);
    sanitized.push({ id: id as HubspotEventType });
  }
  return sanitized;
}

function sanitizeAttioObjectTypeRefs(refs: AttioObjectTypeRef[]): AttioObjectTypeRef[] {
  const seen = new Set<string>();
  const sanitized: AttioObjectTypeRef[] = [];
  for (const ref of refs) {
    if (!isAttioObjectType(ref.id) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    sanitized.push({ id: ref.id });
  }
  return sanitized;
}

function sanitizeAttioEventRefs(refs: AttioEventRef[]): AttioEventRef[] {
  const allowed = new Set<AttioEventType>(GOAT_ATTIO_EVENT_TYPES);
  const seen = new Set<AttioEventType>();
  const sanitized: AttioEventRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id as AttioEventType) || seen.has(id as AttioEventType)) continue;
    seen.add(id as AttioEventType);
    sanitized.push({ id: id as AttioEventType });
  }
  return sanitized;
}

function sanitizeEventTypes(events: GitHubActivityEventType[]): GitHubActivityEventType[] {
  const known = new Set<string>(GITHUB_ACTIVITY_EVENT_TYPES);
  return [...new Set(events)].filter((event) => known.has(event));
}

function sanitizeRepositoryRefs(refs: GitHubRepositoryRef[]): GitHubRepositoryRef[] {
  const seen = new Set<string>();
  const sanitized: GitHubRepositoryRef[] = [];
  for (const ref of refs) {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fullName = typeof ref.fullName === "string" ? ref.fullName.trim() : "";
    sanitized.push({ id, fullName: fullName || id });
  }
  return sanitized;
}

async function loadOwnSlackAccount(userWorkosId: string, integrationId: string) {
  const [integration] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      externalId: integrations.externalId,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, "slack"),
      ),
    )
    .limit(1);
  if (!integration || integration.status !== "connected") return null;

  const credential = await loadIntegrationCredential({
    userWorkosId,
    integrationId,
    provider: "slack",
    kind: "oauth_token",
  }).catch(() => null);
  const token = credential?.payload.access_token;
  const teamId = credential?.payload.team_id ?? integration.externalId;
  const authedUserId = credential?.payload.authed_user_id;
  if (
    typeof token !== "string" ||
    !token ||
    typeof teamId !== "string" ||
    !teamId ||
    typeof authedUserId !== "string" ||
    !authedUserId
  ) {
    return null;
  }
  return { token, teamId, authedUserId };
}

function sanitizeConversationRefs(refs: SlackConversationRef[]): SlackConversationRef[] {
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
