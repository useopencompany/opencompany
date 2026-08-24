import {
  type Actor,
  actorHasPermission,
  CoreError,
  WIKI_READ_PERMISSION,
  WIKI_WRITE_PERMISSION,
} from "@opencompany/core";
import { LINEAR_MCP_EXTERNAL_ID } from "@opencompany/db/linear";
import {
  integrations,
  isWorkspaceOwnedIntegrationProvider,
  type WikiSourceProvider,
} from "@opencompany/db/product-schema";
import {
  deleteWikiSource,
  listWikiSourcesForWorkspace,
  setWikiSourceEnabled,
  upsertWikiSource,
  type WikiSourceWithIntegration,
} from "@opencompany/db/wiki-sources";
import type { UpsertWikiSourceBody, WikiSourceDto } from "@opencompany/protocol";
import { and, eq, isNull, ne, type SQL } from "drizzle-orm";

type DbLike = any;

type SourceIntegration = {
  id: string;
  provider: WikiSourceProvider;
  userWorkosId: string;
  workspaceId: string | null;
  status: WikiSourceWithIntegration["integrationStatus"];
};

export type WikiSourceService = {
  list(actor: Actor): Promise<WikiSourceDto[]>;
  upsert(actor: Actor, command: UpsertWikiSourceBody): Promise<WikiSourceDto>;
  setEnabled(actor: Actor, sourceId: string, enabled: boolean): Promise<WikiSourceDto>;
  remove(actor: Actor, sourceId: string): Promise<void>;
};

export function createWikiSourceService(input: { db: DbLike }): WikiSourceService {
  const db = input.db;

  return {
    async list(actor) {
      requireWikiPermission(actor, WIKI_READ_PERMISSION);
      return listSourceViews(actor, db);
    },

    async upsert(actor, command) {
      requireWikiPermission(actor, WIKI_WRITE_PERMISSION);
      const existing = await findWorkspaceSource(actor, command.integrationId, db);
      if (existing && existing.provider !== command.provider) {
        throw new CoreError("conflict", "The integration is configured for another provider.");
      }
      if (existing && !sourceCapabilities(existing, actor).canConfigure) {
        throw new CoreError(
          "forbidden",
          "Only the connection owner can configure this Wiki source.",
        );
      }

      const integration = await loadSourceIntegration(actor, command, db);
      if (!integration || integration.status === "disconnected") {
        throw new CoreError(
          "conflict",
          `Connect ${providerDisplayName(command.provider)} in Settings first.`,
        );
      }
      if (command.enabled && integration.status !== "connected") {
        throw new CoreError(
          "conflict",
          `Reconnect ${providerDisplayName(command.provider)} before enabling this source.`,
        );
      }

      const result = await upsertWikiSource({
        workspaceId: actor.workspaceId,
        provider: command.provider,
        integrationId: integration.id,
        userWorkosId: integration.userWorkosId,
        createdByWorkosId: actor.userId,
        enabled: command.enabled,
        ...(command.config !== undefined ? { config: command.config } : {}),
        db,
      });
      return requireSourceView(actor, result.id, db);
    },

    async setEnabled(actor, sourceId, enabled) {
      requireWikiPermission(actor, WIKI_WRITE_PERMISSION);
      const source = await requireSourceView(actor, sourceId, db);
      if (!source.canToggle) {
        throw new CoreError(
          "forbidden",
          "Only the connection owner or a workspace admin can change this Wiki source.",
        );
      }
      if (enabled && source.integrationStatus !== "connected") {
        throw new CoreError(
          "conflict",
          `Reconnect ${providerDisplayName(source.provider)} before enabling this source.`,
        );
      }
      const updated = await setWikiSourceEnabled({
        workspaceId: actor.workspaceId,
        sourceId: source.id,
        enabled,
        db,
      });
      if (!updated) throw sourceNotFound();
      return requireSourceView(actor, source.id, db);
    },

    async remove(actor, sourceId) {
      requireWikiPermission(actor, WIKI_WRITE_PERMISSION);
      const source = await requireSourceView(actor, sourceId, db);
      if (!source.canDelete) {
        throw new CoreError(
          "forbidden",
          "Only the connection owner or a workspace admin can remove this Wiki source.",
        );
      }
      const deleted = await deleteWikiSource({
        workspaceId: actor.workspaceId,
        sourceId: source.id,
        db,
      });
      if (!deleted) throw sourceNotFound();
    },
  };
}

async function listSourceViews(actor: Actor, db: DbLike): Promise<WikiSourceDto[]> {
  const sources = await listWikiSourcesForWorkspace(actor.workspaceId, db);
  return sources
    .map((source) => sourceView(source, actor))
    .toSorted((left, right) =>
      `${left.provider}:${left.ownerName ?? left.ownerEmail ?? left.id}`.localeCompare(
        `${right.provider}:${right.ownerName ?? right.ownerEmail ?? right.id}`,
      ),
    );
}

async function findWorkspaceSource(actor: Actor, integrationId: string, db: DbLike) {
  const sources = await listWikiSourcesForWorkspace(actor.workspaceId, db);
  return sources.find((source) => source.integrationId === integrationId) ?? null;
}

async function requireSourceView(actor: Actor, sourceId: string, db: DbLike) {
  const sources = await listWikiSourcesForWorkspace(actor.workspaceId, db);
  const source = sources.find((entry) => entry.id === sourceId);
  if (!source) throw sourceNotFound();
  return sourceView(source, actor);
}

function sourceView(source: WikiSourceWithIntegration, actor: Actor): WikiSourceDto {
  const capabilities = sourceCapabilities(source, actor);
  const workspaceOwned = Boolean(source.integrationWorkspaceId);
  return {
    id: source.id,
    provider: source.provider,
    integrationId: source.integrationId,
    enabled: source.enabled,
    config: source.config,
    integrationStatus: source.integrationStatus,
    accountName: source.integrationAccountName,
    accountEmail: source.integrationAccountEmail,
    connectionLabel: source.integrationConnectionLabel,
    ownerName: source.ownerName,
    ownerEmail: source.ownerEmail,
    ownerAvatarUrl: source.ownerAvatarUrl,
    ownerKind: workspaceOwned ? "workspace" : "user",
    isOwn: !workspaceOwned && source.userWorkosId === actor.userId,
    ...capabilities,
  };
}

function sourceCapabilities(source: WikiSourceWithIntegration, actor: Actor) {
  const isAdmin = actor.role === "admin";
  if (source.integrationWorkspaceId) {
    const canManage = source.integrationWorkspaceId === actor.workspaceId && isAdmin;
    return { canConfigure: canManage, canToggle: canManage, canDelete: canManage };
  }
  const isOwn = source.userWorkosId === actor.userId;
  return {
    canConfigure: isOwn,
    canToggle: isOwn || isAdmin,
    canDelete: isOwn || isAdmin,
  };
}

async function loadSourceIntegration(
  actor: Actor,
  command: Pick<UpsertWikiSourceBody, "integrationId" | "provider">,
  db: DbLike,
): Promise<SourceIntegration | null> {
  const workspaceOwned = isWorkspaceOwnedIntegrationProvider(command.provider);
  if (workspaceOwned && actor.role !== "admin") {
    throw new CoreError("forbidden", "Only workspace admins can configure this Wiki source.");
  }
  const ownerWhere: SQL = workspaceOwned
    ? eq(integrations.workspaceId, actor.workspaceId)
    : and(eq(integrations.userWorkosId, actor.userId), isNull(integrations.workspaceId))!;
  const [integration] = await db
    .select({
      id: integrations.id,
      provider: integrations.provider,
      userWorkosId: integrations.userWorkosId,
      workspaceId: integrations.workspaceId,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, command.integrationId),
        eq(integrations.provider, command.provider),
        ownerWhere,
        ...(command.provider === "linear"
          ? [ne(integrations.externalId, LINEAR_MCP_EXTERNAL_ID)]
          : []),
      ),
    )
    .limit(1);
  return (integration as SourceIntegration | undefined) ?? null;
}

function requireWikiPermission(actor: Actor, permission: string) {
  if (!actor.userId.trim() || !actor.workspaceId.trim() || !actorHasPermission(actor, permission)) {
    throw new CoreError("forbidden", "The actor is not allowed to access Wiki sources.");
  }
}

function sourceNotFound() {
  return new CoreError("not_found", "Wiki source not found.");
}

function providerDisplayName(provider: WikiSourceProvider) {
  if (provider === "github") return "GitHub";
  if (provider === "gmail") return "Gmail";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
