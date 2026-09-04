import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import { GITHUB_ACTIVITY_EVENT_TYPES, type GitHubActivityEventType } from "@opencompany/brain";
import {
  type Actor,
  actorHasPermission,
  BRAIN_READ_PERMISSION,
  CoreError,
} from "@opencompany/core";
import {
  ATTIO_EVENT_TYPES,
  type AttioEventRef,
  type AttioEventType,
  type AttioObjectTypeRef,
  isAttioObjectType,
} from "@opencompany/db/attio";
import {
  deleteBrainSource,
  listBrainSourcesForBrain,
  listPersonalIntegrationAccounts,
  setBrainSourceEnabled,
  upsertBrainSource,
} from "@opencompany/db/brain-sources";
import {
  type GitHubRepositoryRef,
  listGitHubIntegrationRepositories,
} from "@opencompany/db/github";
import {
  GMAIL_EVENT_TYPES,
  type GmailEventRef,
  type GmailEventType,
  sanitizeGmailInstructions,
} from "@opencompany/db/gmail";
import {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
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
  LINEAR_EVENT_TYPES,
  LINEAR_MCP_EXTERNAL_ID,
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
} from "@opencompany/db/product-schema";
import { getBrainAccess } from "@opencompany/db/workspaces";
import { and, desc, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { getAppUrl } from "./app-url";
import type {
  AttioProviderState,
  FathomProviderState,
  GmailSourceProviderState,
  GoogleDriveSourceProviderState,
  GranolaProviderState,
  HubspotSourceProviderState,
  LinearSourceProviderState,
} from "./integration-state";
import type { GitHubProviderState } from "./integrations/github";
import {
  GoogleDriveReconnectRequiredError,
  GoogleDriveRequestError,
  getGoogleDriveFile,
  getGoogleDriveStartPageToken,
  listGoogleDriveFiles,
  listGoogleSharedDrives,
  loadOwnGoogleDriveAccount,
} from "./integrations/google-drive-source";

type DbLike = any;

const SOURCE_INTEGRATION_PROVIDERS = [
  "gmail",
  "google_drive",
  "github",
  "linear",
  "hubspot",
  "granola",
  "fathom",
  "attio",
] as const satisfies readonly IntegrationProvider[];

export type BrainSourceView = {
  sourceId: string;
  provider: BrainSourceConfigProvider;
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
  viewer: { actorId: string; isAdmin: boolean };
  sources: BrainSourceView[];
  ownAccounts: Record<
    "linear" | "gmail" | "google_drive" | "hubspot" | "granola" | "fathom" | "attio",
    OwnSourceAccount[]
  >;
  linear: { integration: LinearSourceProviderState };
  github: { integration: GitHubProviderState };
  gmail: { integration: GmailSourceProviderState };
  googleDrive: { integration: GoogleDriveSourceProviderState };
  hubspot: { integration: HubspotSourceProviderState };
  granola: { integration: GranolaProviderState };
  fathom: { integration: FathomProviderState };
  attio: { integration: AttioProviderState };
};

export type BrainSourceCommand =
  | {
      operation: "set_enabled";
      provider: BrainSourceConfigProvider;
      enabled: boolean;
    }
  | {
      operation: "configure";
      provider: "linear";
      enabled: boolean;
      teams: LinearTeamRef[];
      events: LinearEventRef[];
    }
  | {
      operation: "configure";
      provider: "hubspot";
      enabled: boolean;
      objectTypes: HubspotObjectTypeRef[];
      events: HubspotEventRef[];
    }
  | {
      operation: "configure";
      provider: "attio";
      enabled: boolean;
      objectTypes: AttioObjectTypeRef[];
      events: AttioEventRef[];
    }
  | {
      operation: "configure";
      provider: "github";
      enabled: boolean;
      repos: GitHubRepositoryRef[];
      events: GitHubActivityEventType[];
    }
  | {
      operation: "configure";
      provider: "gmail";
      enabled: boolean;
      events: GmailEventRef[];
      instructions: string;
    }
  | {
      operation: "configure";
      provider: "google_drive";
      enabled: boolean;
      allFiles?: boolean;
      resourceIds: string[];
    };

export type BrainSourceOptionsCommand =
  | { provider: "linear" }
  | { provider: "github" }
  | {
      provider: "google_drive";
      parentId?: string;
      query?: string;
      pageToken?: string;
    };

export type BrainSourceOptions =
  | { provider: "linear"; teams: LinearTeamRef[]; partial: boolean }
  | {
      provider: "github";
      repos: Array<GitHubRepositoryRef & { private: boolean }>;
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
  provider: IntegrationProvider;
  userWorkosId: string;
  workspaceId: string | null;
  externalId: string;
  status: IntegrationStatus;
  accountName: string | null;
  accountEmail: string | null;
  connectionLabel: string | null;
  statusReason: string | null;
};

type ExistingBrainSourceRow = {
  id: string;
  provider: BrainSourceConfigProvider;
  userWorkosId: string;
  integrationWorkspaceId: string | null;
};

export class BrainSourceApplicationService {
  constructor(private readonly db: DbLike) {}

  async list(actor: Actor, brainId: string): Promise<BrainSourcesDetails> {
    const id = await this.authorizeBrain(actor, brainId);
    const isAdmin = actor.role === "admin";
    const [sources, integrationRows, ownAccounts] = await Promise.all([
      listBrainSourcesForBrain(id, this.db),
      this.listRelevantIntegrations(actor),
      this.listOwnAccounts(actor.userId),
    ]);
    const state = sourceProviderStates(integrationRows, actor);
    return {
      viewer: { actorId: actor.userId, isAdmin },
      sources: sources
        .filter((source) => source.provider !== "slack" && source.provider !== "jamie")
        .map((source) => {
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
    await deleteBrainSource({ brainRef: id, sourceId: existing.id, db: this.db });
  }

  async set(actor: Actor, brainId: string, integrationId: string, command: BrainSourceCommand) {
    const id = await this.authorizeBrain(actor, brainId);
    const integration = resourceId(integrationId, "integrationId");
    if (command.operation === "set_enabled") {
      await this.setEnabled(actor, id, integration, command.provider, command.enabled);
      return;
    }
    switch (command.provider) {
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
        const instructions = sanitizeGmailInstructions(command.instructions);
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
    command: BrainSourceOptionsCommand,
  ): Promise<BrainSourceOptions> {
    requireBrainRead(actor);
    const integration = resourceId(integrationId, "integrationId");
    switch (command.provider) {
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
    const access = await getBrainAccess(
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
    provider: BrainSourceConfigProvider,
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
      await setBrainSourceEnabled({
        brainRef: brainId,
        sourceId: existing.id,
        enabled,
        db: this.db,
      });
      return;
    }
    if (isWorkspaceOwnedIntegrationProvider(integrationProvider) && actor.role !== "admin") {
      throw new CoreError("forbidden", "Only workspace admins can configure this source.");
    }
    const integration = await this.loadSourceIntegration(actor, integrationId, integrationProvider);
    if (!integration || integration.status === "disconnected") {
      throw new CoreError("conflict", "Connect this integration in your settings first.");
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
    command: Extract<BrainSourceCommand, { operation: "configure" }>,
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
    command: Extract<BrainSourceCommand, { operation: "configure"; provider: "github" }>,
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
    command: Extract<BrainSourceCommand, { operation: "configure"; provider: "google_drive" }>,
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
      .select({ config: brainSources.config, enabled: brainSources.enabled })
      .from(brainSources)
      .where(and(eq(brainSources.brainId, brainId), eq(brainSources.integrationId, integrationId)))
      .limit(1);
    const existingResources = new Map(
      readGoogleDriveResources(existing?.config).map((resource) => [resource.id, resource]),
    );
    const existingAllFiles = readGoogleDriveAllFiles(existing?.config);

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
    const account = await loadOwnGoogleDriveAccount(actor.userId, integrationId, this.db);
    if (!account) {
      throw new CoreError("forbidden", "Only the connection owner can configure this source.");
    }
    const files = command.allFiles
      ? []
      : await googleDriveBoundaryCall(
          () => Promise.all(resourceIds.map((fileId) => getGoogleDriveFile({ account, fileId }))),
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
      ? await googleDriveBoundaryCall(() => listGoogleSharedDrives({ account }), {
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
              sharedTokens.set(driveId, await getGoogleDriveStartPageToken({ account, driveId }));
            } catch (error) {
              if (
                !(error instanceof GoogleDriveRequestError) ||
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
      () => getGoogleDriveStartPageToken({ account }),
      { fallback: "Google Drive source could not be configured." },
    );
    const webhookAddress = `${getAppUrl()}/api/webhooks/google-drive`;
    const cursors = new Map<GoogleDriveCorpusKey, { driveId: string | null; token: string }>();
    cursors.set("user", { driveId: null, token: userToken });
    for (const [driveId, token] of sharedTokens) {
      cursors.set(`drive:${driveId}`, { driveId, token });
    }
    await Promise.all(
      [...cursors].map(([corpusKey, cursor]) =>
        upsertGoogleDriveSyncCursor({
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
    const allFiles: GoogleDriveAllFilesRef | null = command.allFiles
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
        kind: file.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE ? "folder" : "file",
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

  private async listLinearOptions(
    actor: Actor,
    integrationId: string,
  ): Promise<Extract<BrainSourceOptions, { provider: "linear" }>> {
    const integration = await this.loadSourceIntegration(actor, integrationId, "linear");
    if (!integration || integration.status !== "connected") {
      throw new CoreError("conflict", "Connect Linear in your settings first.");
    }
    const credential = await loadIntegrationCredential({
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
    const teams: LinearTeamRef[] = [];
    let cursor: string | undefined;
    let partial = false;
    try {
      do {
        const page = await linearGraphqlRequest<{
          teams?: {
            nodes?: Array<{
              id?: string;
              key?: string;
              name?: string;
              states?: { nodes?: Array<{ id?: string }> };
            }>;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          };
        }>({
          token,
          query: `query LinearTeams($after: String) {
            teams(first: 100, after: $after) {
              nodes {
                id key name
                states(first: 1, filter: { type: { eq: "triage" } }) { nodes { id } }
              }
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
            ...(team.states?.nodes?.[0]?.id ? { triageStateId: team.states.nodes[0].id } : {}),
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
  ): Promise<Extract<BrainSourceOptions, { provider: "github" }>> {
    if (actor.role !== "admin") {
      throw new CoreError("forbidden", "Only workspace admins can configure brain sources.");
    }
    const integration = await this.loadSourceIntegration(actor, integrationId, "github");
    if (!integration || integration.status !== "connected") {
      throw new CoreError("conflict", "Connect GitHub in your settings first.");
    }
    return {
      provider: "github",
      repos: await listGitHubIntegrationRepositories(integrationId, this.db),
    };
  }

  private async listGoogleDriveOptions(
    actor: Actor,
    integrationId: string,
    command: Extract<BrainSourceOptionsCommand, { provider: "google_drive" }>,
  ): Promise<Extract<BrainSourceOptions, { provider: "google_drive" }>> {
    const parentId = boundedOptional(command.parentId, 512, "parentId");
    const query = boundedOptional(command.query, 200, "query");
    const pageToken = boundedOptional(command.pageToken, 4_096, "pageToken");
    const account = await loadOwnGoogleDriveAccount(actor.userId, integrationId, this.db);
    if (!account) {
      throw new CoreError("conflict", "Connect Google Drive in Settings first.");
    }
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
        provider: "google_drive",
        files: [
          ...sharedDrives.map((drive) => ({
            id: drive.id,
            name: `${drive.name} (Shared Drive)`,
            kind: "folder" as const,
            mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
            driveId: drive.id,
            webViewLink: `https://drive.google.com/drive/folders/${drive.id}`,
          })),
          ...page.files.map((file) => ({
            id: file.id,
            name: file.name,
            kind:
              file.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE
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
      provider: BrainSourceConfigProvider;
      integrationId: string;
      userWorkosId: string;
      enabled: boolean;
      config?: Record<string, unknown>;
    },
  ) {
    const result = await upsertBrainSource({
      ...input,
      createdByWorkosId: actor.userId,
      db: this.db,
    });
    if (result.created && input.enabled) {
      await captureProductServerEvent("brain_source_added", actor.userId, {
        workspace_id: actor.workspaceId,
        brain_id: input.brainRef,
        provider: input.provider,
      });
    }
  }

  private async loadSourceIntegration(
    actor: Actor,
    integrationId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationRow | null> {
    const [integration] = await this.db
      .select({
        id: integrations.id,
        provider: integrations.provider,
        userWorkosId: integrations.userWorkosId,
        workspaceId: integrations.workspaceId,
        externalId: integrations.externalId,
        status: integrations.status,
        accountName: integrations.accountName,
        accountEmail: integrations.accountEmail,
        connectionLabel: integrations.connectionLabel,
        statusReason: integrations.statusReason,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.provider, provider),
          sourceIntegrationOwnerWhere(provider, actor),
          ...(provider === "linear" ? [ne(integrations.externalId, LINEAR_MCP_EXTERNAL_ID)] : []),
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
        id: brainSources.id,
        provider: brainSources.provider,
        userWorkosId: brainSources.userWorkosId,
        integrationWorkspaceId: integrations.workspaceId,
      })
      .from(brainSources)
      .innerJoin(integrations, eq(brainSources.integrationId, integrations.id))
      .where(and(eq(brainSources.brainId, brainId), eq(brainSources.integrationId, integrationId)))
      .limit(1);
    return row ?? null;
  }

  private async listRelevantIntegrations(actor: Actor): Promise<IntegrationRow[]> {
    return this.db
      .select({
        id: integrations.id,
        provider: integrations.provider,
        userWorkosId: integrations.userWorkosId,
        workspaceId: integrations.workspaceId,
        externalId: integrations.externalId,
        status: integrations.status,
        accountName: integrations.accountName,
        accountEmail: integrations.accountEmail,
        connectionLabel: integrations.connectionLabel,
        statusReason: integrations.statusReason,
      })
      .from(integrations)
      .where(
        and(
          inArray(integrations.provider, SOURCE_INTEGRATION_PROVIDERS),
          or(
            and(eq(integrations.userWorkosId, actor.userId), isNull(integrations.workspaceId)),
            eq(integrations.workspaceId, actor.workspaceId),
          ),
        ),
      )
      .orderBy(desc(integrations.updatedAt));
  }

  private async listOwnAccounts(actorId: string): Promise<BrainSourcesDetails["ownAccounts"]> {
    const providers = [
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
        listPersonalIntegrationAccounts({
          userWorkosId: actorId,
          provider,
          ...(provider === "linear" ? { excludeExternalId: LINEAR_MCP_EXTERNAL_ID } : {}),
          db: this.db,
        }),
      ),
    );
    return Object.fromEntries(
      providers.map((provider, index) => [
        provider,
        (accounts[index] ?? []).map(({ externalId: _externalId, ...account }) => account),
      ]),
    ) as BrainSourcesDetails["ownAccounts"];
  }
}

function sourceProviderStates(rows: IntegrationRow[], actor: Actor) {
  const workspaceRow = (provider: "github") =>
    rows.find((row) => row.provider === provider && row.workspaceId === actor.workspaceId);
  const personalRow = (
    provider: Exclude<(typeof SOURCE_INTEGRATION_PROVIDERS)[number], "github">,
  ) => {
    const usesLatestActiveRow =
      provider === "granola" || provider === "fathom" || provider === "attio";
    return rows.find(
      (row) =>
        row.provider === provider &&
        row.userWorkosId === actor.userId &&
        !row.workspaceId &&
        (provider !== "linear" || row.externalId !== LINEAR_MCP_EXTERNAL_ID) &&
        (!usesLatestActiveRow || row.status !== "disconnected"),
    );
  };
  const linearRow = connectedStateRow(personalRow("linear"));
  const githubRow = connectedStateRow(workspaceRow("github"));
  const gmailRow = connectedStateRow(personalRow("gmail"));
  const driveRow = connectedStateRow(personalRow("google_drive"));
  const hubspotRow = connectedStateRow(personalRow("hubspot"));
  const granolaRow = connectedStateRow(personalRow("granola"));
  const fathomRow = connectedStateRow(personalRow("fathom"));
  const attioRow = connectedStateRow(personalRow("attio"));
  return {
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
    error instanceof GoogleDriveReconnectRequiredError ||
    (error instanceof GoogleDriveRequestError && error.status === 401)
  ) {
    return new CoreError("conflict", "Reconnect Google Drive in Settings first.");
  }
  if (
    options.selectedResource &&
    error instanceof GoogleDriveRequestError &&
    (error.status === 403 || error.status === 404)
  ) {
    return new CoreError(
      "invalid_argument",
      "A selected Google Drive item is unavailable or no longer accessible.",
    );
  }
  return new CoreError("unavailable", options.fallback);
}

function emptyLinearState(): LinearSourceProviderState {
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

function emptyGitHubState(): GitHubProviderState {
  return {
    provider: "github",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountName: null,
    statusReason: null,
  };
}

function emptyGmailState(): GmailSourceProviderState {
  return {
    provider: "gmail",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountEmail: null,
    statusReason: null,
  };
}

function emptyDriveState(): GoogleDriveSourceProviderState {
  return {
    provider: "google_drive",
    connected: false,
    status: "not_connected",
    integrationId: null,
    accountEmail: null,
    statusReason: null,
  };
}

function emptyHubspotState(): HubspotSourceProviderState {
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

function emptyGranolaState(): GranolaProviderState {
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

function emptyFathomState(): FathomProviderState {
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

function emptyAttioState(): AttioProviderState {
  return {
    provider: "attio",
    connected: false,
    status: "not_connected",
    integrationId: null,
    workspaceName: null,
    statusReason: null,
  };
}

function integrationProviderFor(provider: BrainSourceConfigProvider): IntegrationProvider | null {
  return provider === "slack" || provider === "slack_bot" ? null : provider;
}

function sourceIntegrationOwnerWhere(provider: IntegrationProvider, actor: Actor): SQL {
  return isWorkspaceOwnedIntegrationProvider(provider)
    ? eq(integrations.workspaceId, actor.workspaceId)
    : and(eq(integrations.userWorkosId, actor.userId), isNull(integrations.workspaceId))!;
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

function providerDisplayName(provider: BrainSourceConfigProvider) {
  switch (provider) {
    case "hubspot":
      return "HubSpot";
    case "google_drive":
      return "Google Drive";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function sanitizeTeamRefs(refs: LinearTeamRef[]): LinearTeamRef[] {
  const seen = new Set<string>();
  return refs.flatMap((ref) => {
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const name = typeof ref.name === "string" ? ref.name.trim() : "";
    const key = typeof ref.key === "string" ? ref.key.trim() : "";
    const triageStateId = typeof ref.triageStateId === "string" ? ref.triageStateId.trim() : "";
    return [
      {
        id,
        name: name || id,
        ...(key ? { key } : {}),
        ...(triageStateId ? { triageStateId } : {}),
      },
    ];
  });
}

function sanitizeGmailEventRefs(refs: GmailEventRef[]): GmailEventRef[] {
  return sanitizeEventRefs(refs, GMAIL_EVENT_TYPES) as GmailEventRef[];
}

function sanitizeLinearEventRefs(refs: LinearEventRef[]): LinearEventRef[] {
  return sanitizeEventRefs(refs, LINEAR_EVENT_TYPES) as LinearEventRef[];
}

function sanitizeHubspotEventRefs(refs: HubspotEventRef[]): HubspotEventRef[] {
  return sanitizeEventRefs(refs, HUBSPOT_EVENT_TYPES) as HubspotEventRef[];
}

function sanitizeAttioEventRefs(refs: AttioEventRef[]): AttioEventRef[] {
  return sanitizeEventRefs(refs, ATTIO_EVENT_TYPES) as AttioEventRef[];
}

function sanitizeEventRefs(
  refs: Array<{ id: string }>,
  allowedValues:
    | readonly GmailEventType[]
    | readonly LinearEventType[]
    | readonly HubspotEventType[]
    | readonly AttioEventType[],
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

function sanitizeHubspotObjectTypeRefs(refs: HubspotObjectTypeRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!isHubspotObjectType(ref.id) || seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

function sanitizeAttioObjectTypeRefs(refs: AttioObjectTypeRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!isAttioObjectType(ref.id) || seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

function sanitizeGitHubEventTypes(events: GitHubActivityEventType[]) {
  const allowed = new Set<string>(GITHUB_ACTIVITY_EVENT_TYPES);
  return [...new Set(events)].filter((event) => allowed.has(event));
}

function sanitizeRepositoryRefs(refs: GitHubRepositoryRef[]) {
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
