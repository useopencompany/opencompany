import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import {
  type Actor,
  actorHasPermission,
  BRAIN_READ_PERMISSION,
  CoreError,
} from "@opencompany/core";
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
import { and, desc, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { getGoatAppUrl } from "./app-url";
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
} from "./integration-state";
import type { GoatGitHubProviderState } from "./integrations/github";
import {
  GoatGoogleDriveReconnectRequiredError,
  GoatGoogleDriveRequestError,
  getGoatGoogleDriveFile,
  getGoatGoogleDriveStartPageToken,
  listGoatGoogleDriveFiles,
  listGoatGoogleSharedDrives,
  loadOwnGoatGoogleDriveAccount,
} from "./integrations/google-drive-source";
import {
  type GoatSlackChannelOption,
  type GoatSlackDmOption,
  listGoatSlackConversationOptions,
} from "./integrations/slack-conversations";

type DbLike = any;

const SOURCE_INTEGRATION_PROVIDERS = [
  "jamie",
  "gmail",
  "google_drive",
  "github",
  "slack",
  "linear",
  "hubspot",
  "granola",
  "fathom",
  "attio",
] as const satisfies readonly GoatIntegrationProvider[];
const JAMIE_API_KEY_EXTERNAL_ID_PREFIX = "jamie_api_key_sha256:";

export type GoatBrainSourceView = {
  sourceId: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  enabled: boolean;
  connectedByName: string;
  ownerEmail: string | null;
  ownerAvatarUrl: string | null;
  accountEmail: string | null;
  accountName: string | null;
  connectionLabel: string | null;
  ownerKind: "workspace" | "user";
  isOwn: boolean;
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
  viewer: { actorId: string; isAdmin: boolean };
  sources: GoatBrainSourceView[];
  ownAccounts: Record<
    "slack" | "linear" | "gmail" | "google_drive" | "hubspot" | "granola" | "fathom" | "attio",
    GoatOwnSourceAccount[]
  >;
  jamie: {
    integration: GoatJamieProviderState;
    legacyDefaultDelivery: boolean;
    isDefaultBrain: boolean;
  };
  slack: { integration: GoatSlackProviderState };
  linear: { integration: GoatLinearSourceProviderState };
  github: { integration: GoatGitHubProviderState };
  gmail: { integration: GoatGmailSourceProviderState };
  googleDrive: { integration: GoatGoogleDriveSourceProviderState };
  hubspot: { integration: GoatHubspotSourceProviderState };
  granola: { integration: GoatGranolaProviderState };
  fathom: { integration: GoatFathomProviderState };
  attio: { integration: GoatAttioProviderState };
};

export type GoatBrainSourceCommand =
  | {
      operation: "set_enabled";
      provider: GoatBrainSourceConfigProvider;
      enabled: boolean;
    }
  | {
      operation: "configure";
      provider: "slack";
      enabled: boolean;
      channels: GoatSlackConversationRef[];
      dms: GoatSlackConversationRef[];
    }
  | {
      operation: "configure";
      provider: "linear";
      enabled: boolean;
      teams: GoatLinearTeamRef[];
      events: GoatLinearEventRef[];
    }
  | {
      operation: "configure";
      provider: "hubspot";
      enabled: boolean;
      objectTypes: GoatHubspotObjectTypeRef[];
      events: GoatHubspotEventRef[];
    }
  | {
      operation: "configure";
      provider: "attio";
      enabled: boolean;
      objectTypes: GoatAttioObjectTypeRef[];
      events: GoatAttioEventRef[];
    }
  | {
      operation: "configure";
      provider: "github";
      enabled: boolean;
      repos: GoatGitHubRepositoryRef[];
      events: GitHubActivityEventType[];
    }
  | {
      operation: "configure";
      provider: "gmail";
      enabled: boolean;
      events: GoatGmailEventRef[];
      instructions: string;
    }
  | {
      operation: "configure";
      provider: "google_drive";
      enabled: boolean;
      allFiles?: boolean;
      resourceIds: string[];
    };

export type GoatBrainSourceOptionsCommand =
  | { provider: "slack" }
  | { provider: "linear" }
  | { provider: "github" }
  | {
      provider: "google_drive";
      parentId?: string;
      query?: string;
      pageToken?: string;
    };

export type GoatBrainSourceOptions =
  | {
      provider: "slack";
      channels: GoatSlackChannelOption[];
      dms: GoatSlackDmOption[];
      partial: boolean;
    }
  | { provider: "linear"; teams: GoatLinearTeamRef[]; partial: boolean }
  | {
      provider: "github";
      repos: Array<GoatGitHubRepositoryRef & { private: boolean }>;
    }
  | {
      provider: "google_drive";
      files: Array<{
        id: string;
        name: string;
        kind: "file" | "folder";
        mimeType: string;
        driveId: string | null;
        webViewLink: string | null;
      }>;
      nextPageToken: string | null;
    };

type IntegrationRow = {
  id: string;
  provider: GoatIntegrationProvider;
  userWorkosId: string;
  workspaceId: string | null;
  externalId: string;
  status: GoatIntegrationStatus;
  accountName: string | null;
  accountEmail: string | null;
  connectionLabel: string | null;
  statusReason: string | null;
};

type ExistingBrainSourceRow = {
  id: string;
  provider: GoatBrainSourceConfigProvider;
  userWorkosId: string;
  integrationWorkspaceId: string | null;
};

export class GoatBrainSourceApplicationService {
  constructor(private readonly db: DbLike) {}

  async list(actor: Actor, brainId: string): Promise<GoatBrainSourcesDetails> {
    const id = await this.authorizeBrain(actor, brainId);
    const isAdmin = actor.role === "admin";
    const [sources, integrationRows, ownAccounts] = await Promise.all([
      listGoatBrainSourcesForBrain(id, this.db),
      this.listRelevantIntegrations(actor),
      this.listOwnAccounts(actor.userId),
    ]);
    const state = sourceProviderStates(integrationRows, actor);
    const jamieConfigured = state.jamie.integrationId
      ? await hasAnyBrainSourceForIntegration(state.jamie.integrationId, this.db)
      : false;
    const jamieOwnerDefaultBrain = state.jamie.integrationId
      ? await this.defaultBrainForIntegrationOwner(state.jamie.integrationId)
      : null;

    return {
      viewer: { actorId: actor.userId, isAdmin },
      sources: sources.map((source) => {
        const workspaceOwned = Boolean(source.integrationWorkspaceId);
        const ownWorkspaceSource =
          workspaceOwned && source.integrationWorkspaceId === actor.workspaceId;
        const isOwn = !workspaceOwned && source.userWorkosId === actor.userId;
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
          ownerKind: workspaceOwned ? "workspace" : "user",
          isOwn,
          canConfigure: workspaceOwned ? ownWorkspaceSource && isAdmin : isOwn,
          canToggle: workspaceOwned ? ownWorkspaceSource && isAdmin : isOwn || isAdmin,
          canRemove: workspaceOwned ? ownWorkspaceSource && isAdmin : isOwn || isAdmin,
          integrationStatus: source.integrationStatus,
          config: source.config,
        };
      }),
      ownAccounts,
      jamie: {
        integration: state.jamie,
        legacyDefaultDelivery: state.jamie.apiKeyConfigured && !jamieConfigured,
        isDefaultBrain: jamieOwnerDefaultBrain?.id === id,
      },
      slack: { integration: state.slack },
      linear: { integration: state.linear },
      github: { integration: state.github },
      gmail: { integration: state.gmail },
      googleDrive: { integration: state.googleDrive },
      hubspot: { integration: state.hubspot },
      granola: { integration: state.granola },
      fathom: { integration: state.fathom },
      attio: { integration: state.attio },
    };
  }

  async remove(actor: Actor, brainId: string, integrationId: string) {
    const id = await this.authorizeBrain(actor, brainId);
    const integration = resourceId(integrationId, "integrationId");
    const existing = await this.loadExistingBrainSource(id, integration);
    if (!existing) return;
    if (!brainSourceCapabilities(existing, actor).canRemove) {
      throw new CoreError(
        "forbidden",
        "Only the source owner or a workspace admin can remove this.",
      );
    }
    await deleteGoatBrainSource({ brainRef: id, sourceId: existing.id, db: this.db });
  }

  async set(actor: Actor, brainId: string, integrationId: string, command: GoatBrainSourceCommand) {
    const id = await this.authorizeBrain(actor, brainId);
    const integration = resourceId(integrationId, "integrationId");
    if (command.operation === "set_enabled") {
      await this.setEnabled(actor, id, integration, command.provider, command.enabled);
      return;
    }
    switch (command.provider) {
      case "slack":
        return this.configurePersonalSource(actor, id, integration, command, {
          channels: sanitizeConversationRefs(command.channels),
          dms: sanitizeConversationRefs(command.dms),
        });
      case "linear":
        return this.configurePersonalSource(actor, id, integration, command, {
          teams: sanitizeTeamRefs(command.teams),
          events: sanitizeLinearEventRefs(command.events),
        });
      case "hubspot":
        return this.configurePersonalSource(actor, id, integration, command, {
          objectTypes: sanitizeHubspotObjectTypeRefs(command.objectTypes),
          events: sanitizeHubspotEventRefs(command.events),
        });
      case "attio":
        return this.configurePersonalSource(actor, id, integration, command, {
          objectTypes: sanitizeAttioObjectTypeRefs(command.objectTypes),
          events: sanitizeAttioEventRefs(command.events),
        });
      case "github":
        return this.configureGitHubSource(actor, id, integration, command);
      case "gmail": {
        const instructions = sanitizeGoatGmailInstructions(command.instructions);
        return this.configurePersonalSource(actor, id, integration, command, {
          events: sanitizeGmailEventRefs(command.events),
          ...(instructions ? { instructions } : {}),
        });
      }
      case "google_drive":
        return this.configureGoogleDriveSource(actor, id, integration, command);
    }
  }

  async listOptions(
    actor: Actor,
    integrationId: string,
    command: GoatBrainSourceOptionsCommand,
  ): Promise<GoatBrainSourceOptions> {
    requireBrainRead(actor);
    const integration = resourceId(integrationId, "integrationId");
    switch (command.provider) {
      case "slack":
        return this.listSlackOptions(actor, integration);
      case "linear":
        return this.listLinearOptions(actor, integration);
      case "github":
        return this.listGitHubOptions(actor, integration);
      case "google_drive":
        return this.listGoogleDriveOptions(actor, integration, command);
    }
  }

  private async authorizeBrain(actor: Actor, brainId: string) {
    requireBrainRead(actor);
    const id = resourceId(brainId, "brainId");
    const access = await getGoatBrainAccess(
      { userWorkosId: actor.userId, brainRef: id },
      { db: this.db },
    );
    if (!access || access.brain.workspaceId !== actor.workspaceId) {
      throw new CoreError("not_found", "Brain not found.");
    }
    return id;
  }

  private async setEnabled(
    actor: Actor,
    brainId: string,
    integrationId: string,
    provider: GoatBrainSourceConfigProvider,
    enabled: boolean,
  ) {
    const integrationProvider = integrationProviderFor(provider);
    if (!integrationProvider) {
      throw new CoreError("invalid_argument", "This source is not available yet.");
    }
    const existing = await this.loadExistingBrainSource(brainId, integrationId);
    if (existing) {
      if (existing.provider !== provider) {
        throw new CoreError("conflict", "The integration is configured for another provider.");
      }
      if (!brainSourceCapabilities(existing, actor).canToggle) {
        throw new CoreError(
          "forbidden",
          "Only the source owner or a workspace admin can change this.",
        );
      }
      await setGoatBrainSourceEnabled({
        brainRef: brainId,
        sourceId: existing.id,
        enabled,
        db: this.db,
      });
      return;
    }
    if (isWorkspaceOwnedGoatIntegrationProvider(integrationProvider) && actor.role !== "admin") {
      throw new CoreError("forbidden", "Only workspace admins can configure this source.");
    }
    const integration = await this.loadSourceIntegration(actor, integrationId, integrationProvider);
    if (!integration || integration.status === "disconnected") {
      throw new CoreError("conflict", "Connect this integration in your settings first.");
    }
    if (provider === "jamie" && !isJamieApiKeyConfigured(integration)) {
      throw new CoreError("conflict", "Save the Jamie API key before adding it as a brain source.");
    }

    const hadExplicitConfig = await hasAnyBrainSourceForIntegration(integrationId, this.db);
    if (!hadExplicitConfig && provider === "jamie") {
      const defaultBrain = await getDefaultGoatBrainForUser(integration.userWorkosId, {
        db: this.db,
      });
      if (defaultBrain && defaultBrain.id !== brainId) {
        await upsertGoatBrainSource({
          brainRef: defaultBrain.id,
          provider,
          integrationId,
          userWorkosId: integration.userWorkosId,
          createdByWorkosId: actor.userId,
          enabled: true,
          db: this.db,
        });
      }
    }
    await this.upsertSource(actor, {
      brainRef: brainId,
      provider,
      integrationId,
      userWorkosId: integration.userWorkosId,
      enabled,
    });
  }

  private async configurePersonalSource(
    actor: Actor,
    brainId: string,
    integrationId: string,
    command: Extract<GoatBrainSourceCommand, { operation: "configure" }>,
    config: Record<string, unknown>,
  ) {
    const integration = await this.loadSourceIntegration(actor, integrationId, command.provider);
    if (!integration || integration.status === "disconnected") {
      throw new CoreError(
        "conflict",
        `Connect ${providerDisplayName(command.provider)} in your settings first.`,
      );
    }
    await this.upsertSource(actor, {
      brainRef: brainId,
      provider: command.provider,
      integrationId,
      userWorkosId: integration.userWorkosId,
      enabled: command.enabled,
      config,
    });
  }

  private async configureGitHubSource(
    actor: Actor,
    brainId: string,
    integrationId: string,
    command: Extract<GoatBrainSourceCommand, { operation: "configure"; provider: "github" }>,
  ) {
    if (actor.role !== "admin") {
      throw new CoreError("forbidden", "Only workspace admins can configure brain sources.");
    }
    const integration = await this.loadSourceIntegration(actor, integrationId, "github");
    if (!integration || integration.status === "disconnected") {
      throw new CoreError("conflict", "Connect GitHub in your settings first.");
    }
    await this.upsertSource(actor, {
      brainRef: brainId,
      provider: "github",
      integrationId,
      userWorkosId: integration.userWorkosId,
      enabled: command.enabled,
      config: {
        repos: sanitizeRepositoryRefs(command.repos),
        events: sanitizeGitHubEventTypes(command.events),
      },
    });
  }

  private async configureGoogleDriveSource(
    actor: Actor,
    brainId: string,
    integrationId: string,
    command: Extract<GoatBrainSourceCommand, { operation: "configure"; provider: "google_drive" }>,
  ) {
    const integration = await this.loadSourceIntegration(actor, integrationId, "google_drive");
    if (!integration) {
      throw new CoreError("forbidden", "Only the connection owner can configure this source.");
    }
    const resourceIds = uniqueBoundedIds(command.resourceIds, 100, 512, "Google Drive resource");
    if (command.enabled && !command.allFiles && resourceIds.length === 0) {
      throw new CoreError(
        "invalid_argument",
        "Select at least one Drive file or folder, or choose all files.",
      );
    }
    const [existing] = await this.db
      .select({ config: goatBrainSources.config, enabled: goatBrainSources.enabled })
      .from(goatBrainSources)
      .where(
        and(
          eq(goatBrainSources.brainId, brainId),
          eq(goatBrainSources.integrationId, integrationId),
        ),
      )
      .limit(1);
    const existingResources = new Map(
      readGoatGoogleDriveResources(existing?.config).map((resource) => [resource.id, resource]),
    );
    const existingAllFiles = readGoatGoogleDriveAllFiles(existing?.config);

    if (!command.enabled) {
      const resources = resourceIds.flatMap((id) => existingResources.get(id) ?? []);
      const allFiles = command.allFiles ? existingAllFiles : null;
      await this.upsertSource(actor, {
        brainRef: brainId,
        provider: "google_drive",
        integrationId,
        userWorkosId: integration.userWorkosId,
        enabled: false,
        config: { ...(allFiles ? { allFiles } : {}), resources },
      });
      return;
    }
    if (integration.status === "disconnected") {
      throw new CoreError("conflict", "Reconnect Google Drive in Settings first.");
    }
    const account = await loadOwnGoatGoogleDriveAccount(actor.userId, integrationId, this.db);
    if (!account) {
      throw new CoreError("forbidden", "Only the connection owner can configure this source.");
    }
    const files = command.allFiles
      ? []
      : await googleDriveBoundaryCall(
          () =>
            Promise.all(resourceIds.map((fileId) => getGoatGoogleDriveFile({ account, fileId }))),
          {
            fallback: "Google Drive source could not be configured.",
            selectedResource: true,
          },
        );
    if (files.some((file) => file.trashed)) {
      throw new CoreError("invalid_argument", "Remove trashed Drive items before saving.");
    }
    const resetSelectionTimes = Boolean(existing && !existing.enabled && command.enabled);
    const sharedDrives = command.allFiles
      ? await googleDriveBoundaryCall(() => listGoatGoogleSharedDrives({ account }), {
          fallback: "Google Drive source could not be configured.",
        })
      : [];
    const driveIds = [
      ...new Set([
        ...files.flatMap((file) => (file.driveId ? [file.driveId] : [])),
        ...sharedDrives.map((drive) => drive.id),
      ]),
    ];
    const sharedTokens = new Map<string, string>();
    await googleDriveBoundaryCall(
      () =>
        Promise.all(
          driveIds.map(async (driveId) => {
            try {
              sharedTokens.set(
                driveId,
                await getGoatGoogleDriveStartPageToken({ account, driveId }),
              );
            } catch (error) {
              if (
                !(error instanceof GoatGoogleDriveRequestError) ||
                (error.status !== 403 && error.status !== 404)
              ) {
                throw error;
              }
            }
          }),
        ),
      { fallback: "Google Drive source could not be configured." },
    );
    const userToken = await googleDriveBoundaryCall(
      () => getGoatGoogleDriveStartPageToken({ account }),
      { fallback: "Google Drive source could not be configured." },
    );
    const webhookAddress = `${getGoatAppUrl()}/api/webhooks/google-drive`;
    const cursors = new Map<GoatGoogleDriveCorpusKey, { driveId: string | null; token: string }>();
    cursors.set("user", { driveId: null, token: userToken });
    for (const [driveId, token] of sharedTokens) {
      cursors.set(`drive:${driveId}`, { driveId, token });
    }
    await Promise.all(
      [...cursors].map(([corpusKey, cursor]) =>
        upsertGoatGoogleDriveSyncCursor({
          integrationId,
          userWorkosId: integration.userWorkosId,
          corpusKey,
          driveId: cursor.driveId,
          pageToken: cursor.token,
          webhookAddress,
          db: this.db,
        }),
      ),
    );

    // Cursors are durable before selection timestamps, preserving the no-gap
    // boundary between historical data and the first watched change.
    const selectedAt = new Date().toISOString();
    const allFiles: GoatGoogleDriveAllFilesRef | null = command.allFiles
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
    await this.upsertSource(actor, {
      brainRef: brainId,
      provider: "google_drive",
      integrationId,
      userWorkosId: integration.userWorkosId,
      enabled: true,
      config: { ...(allFiles ? { allFiles } : {}), resources },
    });
  }

  private async listSlackOptions(
    actor: Actor,
    integrationId: string,
  ): Promise<Extract<GoatBrainSourceOptions, { provider: "slack" }>> {
    const integration = await this.loadSourceIntegration(actor, integrationId, "slack");
    if (!integration || integration.status !== "connected") {
      throw new CoreError("conflict", "Connect Slack in your settings first.");
    }
    const credential = await loadGoatIntegrationCredential({
      userWorkosId: actor.userId,
      integrationId,
      provider: "slack",
      kind: "oauth_token",
      db: this.db,
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
      throw new CoreError("conflict", "Connect Slack in your settings first.");
    }
    const options = await listGoatSlackConversationOptions({ token, teamId, authedUserId });
    return { provider: "slack", ...options };
  }

  private async listLinearOptions(
    actor: Actor,
    integrationId: string,
  ): Promise<Extract<GoatBrainSourceOptions, { provider: "linear" }>> {
    const integration = await this.loadSourceIntegration(actor, integrationId, "linear");
    if (!integration || integration.status !== "connected") {
      throw new CoreError("conflict", "Connect Linear in your settings first.");
    }
    const credential = await loadGoatIntegrationCredential({
      userWorkosId: actor.userId,
      integrationId,
      provider: "linear",
      kind: "oauth_token",
      db: this.db,
    }).catch(() => null);
    const token = credential?.payload.access_token;
    if (typeof token !== "string" || !token) {
      throw new CoreError("conflict", "Connect Linear in your settings first.");
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
      partial = true;
    }
    teams.sort((a, b) => a.name.localeCompare(b.name));
    return { provider: "linear", teams, partial };
  }

  private async listGitHubOptions(
    actor: Actor,
    integrationId: string,
  ): Promise<Extract<GoatBrainSourceOptions, { provider: "github" }>> {
    if (actor.role !== "admin") {
      throw new CoreError("forbidden", "Only workspace admins can configure brain sources.");
    }
    const integration = await this.loadSourceIntegration(actor, integrationId, "github");
    if (!integration || integration.status !== "connected") {
      throw new CoreError("conflict", "Connect GitHub in your settings first.");
    }
    return {
      provider: "github",
      repos: await listGoatGitHubIntegrationRepositories(integrationId, this.db),
    };
  }

  private async listGoogleDriveOptions(
    actor: Actor,
    integrationId: string,
    command: Extract<GoatBrainSourceOptionsCommand, { provider: "google_drive" }>,
  ): Promise<Extract<GoatBrainSourceOptions, { provider: "google_drive" }>> {
    const parentId = boundedOptional(command.parentId, 512, "parentId");
    const query = boundedOptional(command.query, 200, "query");
    const pageToken = boundedOptional(command.pageToken, 4_096, "pageToken");
    const account = await loadOwnGoatGoogleDriveAccount(actor.userId, integrationId, this.db);
    if (!account) {
      throw new CoreError("conflict", "Connect Google Drive in Settings first.");
    }
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
        provider: "google_drive",
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
      throw googleDriveBoundaryError(error, {
        fallback: "Could not load Google Drive files.",
      });
    }
  }

  private async upsertSource(
    actor: Actor,
    input: {
      brainRef: string;
      provider: GoatBrainSourceConfigProvider;
      integrationId: string;
      userWorkosId: string;
      enabled: boolean;
      config?: Record<string, unknown>;
    },
  ) {
    const result = await upsertGoatBrainSource({
      ...input,
      createdByWorkosId: actor.userId,
      db: this.db,
    });
    if (result.created && input.enabled) {
      await captureGoatServerEvent("brain_source_added", actor.userId, {
        workspace_id: actor.workspaceId,
        brain_id: input.brainRef,
        provider: input.provider,
      });
    }
  }

  private async loadSourceIntegration(
    actor: Actor,
    integrationId: string,
    provider: GoatIntegrationProvider,
  ): Promise<IntegrationRow | null> {
    const [integration] = await this.db
      .select({
        id: goatIntegrations.id,
        provider: goatIntegrations.provider,
        userWorkosId: goatIntegrations.userWorkosId,
        workspaceId: goatIntegrations.workspaceId,
        externalId: goatIntegrations.externalId,
        status: goatIntegrations.status,
        accountName: goatIntegrations.accountName,
        accountEmail: goatIntegrations.accountEmail,
        connectionLabel: goatIntegrations.connectionLabel,
        statusReason: goatIntegrations.statusReason,
      })
      .from(goatIntegrations)
      .where(
        and(
          eq(goatIntegrations.id, integrationId),
          eq(goatIntegrations.provider, provider),
          sourceIntegrationOwnerWhere(provider, actor),
          ...(provider === "linear"
            ? [ne(goatIntegrations.externalId, GOAT_LINEAR_MCP_EXTERNAL_ID)]
            : []),
        ),
      )
      .limit(1);
    return integration ?? null;
  }

  private async loadExistingBrainSource(
    brainId: string,
    integrationId: string,
  ): Promise<ExistingBrainSourceRow | null> {
    const [row] = await this.db
      .select({
        id: goatBrainSources.id,
        provider: goatBrainSources.provider,
        userWorkosId: goatBrainSources.userWorkosId,
        integrationWorkspaceId: goatIntegrations.workspaceId,
      })
      .from(goatBrainSources)
      .innerJoin(goatIntegrations, eq(goatBrainSources.integrationId, goatIntegrations.id))
      .where(
        and(
          eq(goatBrainSources.brainId, brainId),
          eq(goatBrainSources.integrationId, integrationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async listRelevantIntegrations(actor: Actor): Promise<IntegrationRow[]> {
    return this.db
      .select({
        id: goatIntegrations.id,
        provider: goatIntegrations.provider,
        userWorkosId: goatIntegrations.userWorkosId,
        workspaceId: goatIntegrations.workspaceId,
        externalId: goatIntegrations.externalId,
        status: goatIntegrations.status,
        accountName: goatIntegrations.accountName,
        accountEmail: goatIntegrations.accountEmail,
        connectionLabel: goatIntegrations.connectionLabel,
        statusReason: goatIntegrations.statusReason,
      })
      .from(goatIntegrations)
      .where(
        and(
          inArray(goatIntegrations.provider, SOURCE_INTEGRATION_PROVIDERS),
          or(
            and(
              eq(goatIntegrations.userWorkosId, actor.userId),
              isNull(goatIntegrations.workspaceId),
            ),
            eq(goatIntegrations.workspaceId, actor.workspaceId),
          ),
        ),
      )
      .orderBy(desc(goatIntegrations.updatedAt));
  }

  private async listOwnAccounts(actorId: string): Promise<GoatBrainSourcesDetails["ownAccounts"]> {
    const providers = [
      "slack",
      "linear",
      "gmail",
      "google_drive",
      "hubspot",
      "granola",
      "fathom",
      "attio",
    ] as const;
    const accounts = await Promise.all(
      providers.map((provider) =>
        listGoatPersonalIntegrationAccounts({
          userWorkosId: actorId,
          provider,
          ...(provider === "linear" ? { excludeExternalId: GOAT_LINEAR_MCP_EXTERNAL_ID } : {}),
          db: this.db,
        }),
      ),
    );
    return Object.fromEntries(
      providers.map((provider, index) => [
        provider,
        (accounts[index] ?? []).map(({ externalId: _externalId, ...account }) => account),
      ]),
    ) as GoatBrainSourcesDetails["ownAccounts"];
  }

  private async defaultBrainForIntegrationOwner(integrationId: string) {
    const [row] = await this.db
      .select({ userWorkosId: goatIntegrations.userWorkosId })
      .from(goatIntegrations)
      .where(eq(goatIntegrations.id, integrationId))
      .limit(1);
    return row ? getDefaultGoatBrainForUser(row.userWorkosId, { db: this.db }) : null;
  }
}

function sourceProviderStates(rows: IntegrationRow[], actor: Actor) {
  const workspaceRow = (provider: "jamie" | "github") =>
    rows.find((row) => row.provider === provider && row.workspaceId === actor.workspaceId);
  const personalRow = (
    provider: Exclude<(typeof SOURCE_INTEGRATION_PROVIDERS)[number], "jamie" | "github">,
  ) => {
    const usesLatestActiveRow =
      provider === "granola" || provider === "fathom" || provider === "attio";
    return rows.find(
      (row) =>
        row.provider === provider &&
        row.userWorkosId === actor.userId &&
        !row.workspaceId &&
        (provider !== "linear" || row.externalId !== GOAT_LINEAR_MCP_EXTERNAL_ID) &&
        (!usesLatestActiveRow || row.status !== "disconnected"),
    );
  };
  const jamieRow = connectedStateRow(workspaceRow("jamie"));
  const slackRow = connectedStateRow(personalRow("slack"));
  const linearRow = connectedStateRow(personalRow("linear"));
  const githubRow = connectedStateRow(workspaceRow("github"));
  const gmailRow = connectedStateRow(personalRow("gmail"));
  const driveRow = connectedStateRow(personalRow("google_drive"));
  const hubspotRow = connectedStateRow(personalRow("hubspot"));
  const granolaRow = connectedStateRow(personalRow("granola"));
  const fathomRow = connectedStateRow(personalRow("fathom"));
  const attioRow = connectedStateRow(personalRow("attio"));
  return {
    jamie: jamieRow
      ? {
          provider: "jamie" as const,
          connected: jamieRow.status === "connected",
          status: jamieRow.status,
          accountName: jamieRow.accountName,
          statusReason: jamieRow.statusReason,
          integrationId: jamieRow.id,
          webhookUrl: `${getGoatAppUrl()}/api/webhooks/jamie`,
          apiKeyConfigured: isJamieApiKeyConfigured(jamieRow),
        }
      : emptyJamieState(),
    slack: slackRow
      ? {
          provider: "slack" as const,
          connected: slackRow.status === "connected",
          status: slackRow.status,
          integrationId: slackRow.id,
          accountName: slackRow.accountName,
          teamName: slackRow.connectionLabel,
          statusReason: slackRow.statusReason,
        }
      : emptySlackState(),
    linear: linearRow
      ? {
          provider: "linear" as const,
          connected: linearRow.status === "connected",
          status: linearRow.status,
          integrationId: linearRow.id,
          accountName: linearRow.accountName,
          organizationName: linearRow.connectionLabel,
          statusReason: linearRow.statusReason,
        }
      : emptyLinearState(),
    github: githubRow
      ? {
          provider: "github" as const,
          connected: githubRow.status === "connected",
          status: githubRow.status,
          integrationId: githubRow.id,
          accountName: githubRow.accountName,
          statusReason: githubRow.statusReason,
        }
      : emptyGitHubState(),
    gmail: gmailRow
      ? {
          provider: "gmail" as const,
          connected: gmailRow.status === "connected",
          status: gmailRow.status,
          integrationId: gmailRow.id,
          accountEmail: gmailRow.accountEmail,
          statusReason: gmailRow.statusReason,
        }
      : emptyGmailState(),
    googleDrive: driveRow
      ? {
          provider: "google_drive" as const,
          connected: driveRow.status === "connected",
          status: driveRow.status,
          integrationId: driveRow.id,
          accountEmail: driveRow.accountEmail,
          statusReason: driveRow.statusReason,
        }
      : emptyDriveState(),
    hubspot: hubspotRow
      ? {
          provider: "hubspot" as const,
          connected: hubspotRow.status === "connected",
          status: hubspotRow.status,
          integrationId: hubspotRow.id,
          accountEmail: hubspotRow.accountEmail,
          hubDomain: hubspotRow.connectionLabel,
          statusReason: hubspotRow.statusReason,
        }
      : emptyHubspotState(),
    granola: granolaRow
      ? {
          provider: "granola" as const,
          connected: granolaRow.status === "connected",
          status: granolaRow.status,
          integrationId: granolaRow.id,
          accountEmail: granolaRow.accountEmail,
          accountName: granolaRow.accountName,
          statusReason: granolaRow.statusReason,
        }
      : emptyGranolaState(),
    fathom: fathomRow
      ? {
          provider: "fathom" as const,
          connected: fathomRow.status === "connected",
          status: fathomRow.status,
          integrationId: fathomRow.id,
          accountEmail: fathomRow.accountEmail,
          accountName: fathomRow.accountName,
          statusReason: fathomRow.statusReason,
        }
      : emptyFathomState(),
    attio: attioRow
      ? {
          provider: "attio" as const,
          connected: attioRow.status === "connected",
          status: attioRow.status,
          integrationId: attioRow.id,
          workspaceName: attioRow.connectionLabel,
          statusReason: attioRow.statusReason,
        }
      : emptyAttioState(),
  };
}

function connectedStateRow(row: IntegrationRow | undefined) {
  return !row || row.status === "disconnected" ? undefined : row;
}

async function googleDriveBoundaryCall<T>(
  operation: () => Promise<T>,
  options: { fallback: string; selectedResource?: boolean },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw googleDriveBoundaryError(error, options);
  }
}

function googleDriveBoundaryError(
  error: unknown,
  options: { fallback: string; selectedResource?: boolean },
) {
  if (error instanceof CoreError) return error;
  if (
    error instanceof GoatGoogleDriveReconnectRequiredError ||
    (error instanceof GoatGoogleDriveRequestError && error.status === 401)
  ) {
    return new CoreError("conflict", "Reconnect Google Drive in Settings first.");
  }
  if (
    options.selectedResource &&
    error instanceof GoatGoogleDriveRequestError &&
    (error.status === 403 || error.status === 404)
  ) {
    return new CoreError(
      "invalid_argument",
      "A selected Google Drive item is unavailable or no longer accessible.",
    );
  }
  return new CoreError("unavailable", options.fallback);
}

function emptyJamieState(): GoatJamieProviderState {
  return {
    provider: "jamie",
    connected: false,
    status: "not_connected",
    accountName: null,
    statusReason: null,
    integrationId: null,
    webhookUrl: null,
    apiKeyConfigured: false,
  };
}

function emptySlackState(): GoatSlackProviderState {
  return {
    provider: "slack",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountName: null,
    teamName: null,
    statusReason: null,
  };
}

function emptyLinearState(): GoatLinearSourceProviderState {
  return {
    provider: "linear",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountName: null,
    organizationName: null,
    statusReason: null,
  };
}

function emptyGitHubState(): GoatGitHubProviderState {
  return {
    provider: "github",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountName: null,
    statusReason: null,
  };
}

function emptyGmailState(): GoatGmailSourceProviderState {
  return {
    provider: "gmail",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountEmail: null,
    statusReason: null,
  };
}

function emptyDriveState(): GoatGoogleDriveSourceProviderState {
  return {
    provider: "google_drive",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountEmail: null,
    statusReason: null,
  };
}

function emptyHubspotState(): GoatHubspotSourceProviderState {
  return {
    provider: "hubspot",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountEmail: null,
    hubDomain: null,
    statusReason: null,
  };
}

function emptyGranolaState(): GoatGranolaProviderState {
  return {
    provider: "granola",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountEmail: null,
    accountName: null,
    statusReason: null,
  };
}

function emptyFathomState(): GoatFathomProviderState {
  return {
    provider: "fathom",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountEmail: null,
    accountName: null,
    statusReason: null,
  };
}

function emptyAttioState(): GoatAttioProviderState {
  return {
    provider: "attio",
    connected: false,
    status: "not_connected",
    integrationId: null,
    workspaceName: null,
    statusReason: null,
  };
}

function integrationProviderFor(
  provider: GoatBrainSourceConfigProvider,
): GoatIntegrationProvider | null {
  return provider === "slack_bot" ? null : provider;
}

function sourceIntegrationOwnerWhere(provider: GoatIntegrationProvider, actor: Actor): SQL {
  return isWorkspaceOwnedGoatIntegrationProvider(provider)
    ? eq(goatIntegrations.workspaceId, actor.workspaceId)
    : and(eq(goatIntegrations.userWorkosId, actor.userId), isNull(goatIntegrations.workspaceId))!;
}

function brainSourceCapabilities(source: ExistingBrainSourceRow, actor: Actor) {
  const isAdmin = actor.role === "admin";
  if (source.integrationWorkspaceId) {
    const managed = source.integrationWorkspaceId === actor.workspaceId && isAdmin;
    return { canConfigure: managed, canToggle: managed, canRemove: managed };
  }
  const isOwn = source.userWorkosId === actor.userId;
  return { canConfigure: isOwn, canToggle: isOwn || isAdmin, canRemove: isOwn || isAdmin };
}

function isJamieApiKeyConfigured(input: Pick<IntegrationRow, "status" | "externalId">) {
  return (
    input.status === "connected" || input.externalId.startsWith(JAMIE_API_KEY_EXTERNAL_ID_PREFIX)
  );
}

function requireBrainRead(actor: Actor) {
  if (!actorHasPermission(actor, BRAIN_READ_PERMISSION)) {
    throw new CoreError("forbidden", "Brain permission is required.");
  }
}

function resourceId(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

function boundedOptional(value: string | undefined, max: number, field: string) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > max) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

function uniqueBoundedIds(values: string[], maxItems: number, maxLength: number, label: string) {
  const ids = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (ids.length > maxItems || ids.some((id) => id.length > maxLength)) {
    throw new CoreError(
      "invalid_argument",
      ids.length > maxItems
        ? `Select at most ${maxItems} ${label}s per brain.`
        : `Invalid ${label} id.`,
    );
  }
  return ids;
}

function providerDisplayName(provider: GoatBrainSourceConfigProvider) {
  switch (provider) {
    case "hubspot":
      return "HubSpot";
    case "google_drive":
      return "Google Drive";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function sanitizeConversationRefs(refs: GoatSlackConversationRef[]) {
  return sanitizeNamedRefs(refs);
}

function sanitizeTeamRefs(refs: GoatLinearTeamRef[]): GoatLinearTeamRef[] {
  const seen = new Set<string>();
  return refs.flatMap((ref) => {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const name = typeof ref.name === "string" ? ref.name.trim() : "";
    const key = typeof ref.key === "string" ? ref.key.trim() : "";
    return [{ id, name: name || id, ...(key ? { key } : {}) }];
  });
}

function sanitizeNamedRefs(refs: Array<{ id: string; name: string }>) {
  const seen = new Set<string>();
  return refs.flatMap((ref) => {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const name = typeof ref.name === "string" ? ref.name.trim() : "";
    return [{ id, name: name || id }];
  });
}

function sanitizeGmailEventRefs(refs: GoatGmailEventRef[]): GoatGmailEventRef[] {
  return sanitizeEventRefs(refs, GOAT_GMAIL_EVENT_TYPES) as GoatGmailEventRef[];
}

function sanitizeLinearEventRefs(refs: GoatLinearEventRef[]): GoatLinearEventRef[] {
  return sanitizeEventRefs(refs, GOAT_LINEAR_EVENT_TYPES) as GoatLinearEventRef[];
}

function sanitizeHubspotEventRefs(refs: GoatHubspotEventRef[]): GoatHubspotEventRef[] {
  return sanitizeEventRefs(refs, GOAT_HUBSPOT_EVENT_TYPES) as GoatHubspotEventRef[];
}

function sanitizeAttioEventRefs(refs: GoatAttioEventRef[]): GoatAttioEventRef[] {
  return sanitizeEventRefs(refs, GOAT_ATTIO_EVENT_TYPES) as GoatAttioEventRef[];
}

function sanitizeEventRefs(
  refs: Array<{ id: string }>,
  allowedValues:
    | readonly GoatGmailEventType[]
    | readonly GoatLinearEventType[]
    | readonly GoatHubspotEventType[]
    | readonly GoatAttioEventType[],
) {
  const allowed = new Set<string>(allowedValues);
  const seen = new Set<string>();
  return refs.flatMap((ref) => {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!allowed.has(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
}

function sanitizeHubspotObjectTypeRefs(refs: GoatHubspotObjectTypeRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!isGoatHubspotObjectType(ref.id) || seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

function sanitizeAttioObjectTypeRefs(refs: GoatAttioObjectTypeRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!isGoatAttioObjectType(ref.id) || seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

function sanitizeGitHubEventTypes(events: GitHubActivityEventType[]) {
  const allowed = new Set<string>(GITHUB_ACTIVITY_EVENT_TYPES);
  return [...new Set(events)].filter((event) => allowed.has(event));
}

function sanitizeRepositoryRefs(refs: GoatGitHubRepositoryRef[]) {
  const seen = new Set<string>();
  return refs.flatMap((ref) => {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const fullName = typeof ref.fullName === "string" ? ref.fullName.trim() : "";
    return [{ id, fullName: fullName || id }];
  });
}

async function linearGraphqlRequest<T>(input: {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<T> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` },
    body: JSON.stringify({
      query: input.query,
      ...(input.variables ? { variables: input.variables } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Linear GraphQL request failed with ${response.status}.`);
  const result = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (result.errors?.length) {
    throw new Error(`Linear GraphQL returned ${result.errors[0]?.message ?? "an unknown error"}.`);
  }
  if (!result.data) throw new Error("Linear GraphQL returned no data.");
  return result.data;
}
