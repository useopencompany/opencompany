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
  listWikiIngestActivityRows,
  type WikiIngestActivityRow,
} from "@opencompany/db/wiki-ingest";
import {
  deleteWikiSource,
  listWikiSourcesForWorkspace,
  setWikiSourceEnabled,
  upsertWikiSource,
  type WikiSourceWithIntegration,
} from "@opencompany/db/wiki-sources";
import type {
  UpsertWikiSourceBody,
  WikiIngestActivityItemDto,
  WikiIngestActivityPageDto,
  WikiSourceDto,
} from "@opencompany/protocol";
import { isValidWikiPath } from "@opencompany/wiki";
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
  listActivity(
    actor: Actor,
    input: { limit: number; cursor?: string },
  ): Promise<WikiIngestActivityPageDto>;
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

    async listActivity(actor, command) {
      requireWikiPermission(actor, WIKI_READ_PERMISSION);
      const before = decodeActivityCursor(command.cursor);
      const rows = await listWikiIngestActivityRows({
        workspaceId: actor.workspaceId,
        limit: command.limit + 1,
        before,
        db,
      });
      const visible = rows.slice(0, command.limit);
      const last = visible.at(-1);
      return {
        items: visible.map(wikiIngestActivityView),
        nextCursor:
          rows.length > command.limit && last
            ? encodeActivityCursor(last.createdAt, last.id)
            : null,
      };
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

function wikiIngestActivityView(row: WikiIngestActivityRow): WikiIngestActivityItemDto {
  return {
    id: row.id,
    provider: row.sourceProvider,
    sourceType: row.sourceType,
    title: boundedNullableString(row.title, 512),
    outcome: row.status,
    reason: activityReason(row),
    pages: row.status === "succeeded" ? activityPages(row.result) : [],
    attempts: row.attempts,
    occurredAt: row.occurredAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function activityReason(row: WikiIngestActivityRow) {
  if (row.status === "skipped") {
    return boundedNullableString(
      row.skipReason ?? resultString(row.result, "reason") ?? resultString(row.result, "summary"),
      2_000,
    );
  }
  if (row.status === "failed" || (row.status === "queued" && row.attempts > 0)) {
    return boundedNullableString(row.lastError, 2_000);
  }
  return null;
}

function activityPages(result: Record<string, unknown>) {
  const explicitPages = Array.isArray(result.pages) ? result.pages.flatMap(parseActivityPage) : [];
  const pages = explicitPages.length > 0 ? explicitPages : activityPagesFromTrace(result.trace);
  const unique = new Map<string, WikiIngestActivityItemDto["pages"][number]>();
  for (const page of pages) {
    unique.set(page.path, page);
    if (unique.size >= 100) break;
  }
  return [...unique.values()];
}

function activityPagesFromTrace(traceValue: unknown): WikiIngestActivityItemDto["pages"] {
  const trace = asRecord(traceValue);
  if (!trace || !Array.isArray(trace.toolCalls)) return [];
  const pages: WikiIngestActivityItemDto["pages"] = [];
  for (const value of trace.toolCalls) {
    const call = asRecord(value);
    if (!call || call.status !== "completed" || call.mutating !== true) continue;
    const input = parseJsonRecord(call.inputPreview);
    const output = parseJsonRecord(call.outputPreview);
    const command = typeof call.command === "string" ? call.command : input?.command;
    if (command === "write") {
      if (output?.action === "unchanged") continue;
      pages.push(
        ...activityPage(
          output?.path ?? input?.path,
          output?.title ?? input?.title,
          output?.action === "created" ? "created" : "updated",
        ),
      );
    } else if (command === "mkdir") {
      if (output?.action === "unchanged") continue;
      pages.push(...activityPage(output?.path ?? input?.path, output?.title, "created"));
    } else if (command === "timeline-add") {
      pages.push(...activityPage(firstPageRef(input?.pages), null, "updated"));
    } else if (command === "move") {
      pages.push(...activityPage(output?.path, null, "moved"));
      for (const path of stringArray(output?.rewrittenReferrers)) {
        pages.push(...activityPage(path, null, "updated"));
      }
    } else if (command === "delete") {
      for (const path of stringArray(output?.deletedPaths)) {
        pages.push(...activityPage(path, null, "deleted"));
      }
    }
  }
  return pages;
}

function parseActivityPage(value: unknown): WikiIngestActivityItemDto["pages"] {
  const page = asRecord(value);
  if (!page) return [];
  const action = page.action;
  if (action !== "created" && action !== "updated" && action !== "moved" && action !== "deleted") {
    return [];
  }
  return activityPage(page.path, page.title, action);
}

function activityPage(
  pathValue: unknown,
  titleValue: unknown,
  action: WikiIngestActivityItemDto["pages"][number]["action"],
): WikiIngestActivityItemDto["pages"] {
  const path = boundedString(pathValue, 512);
  if (!isValidWikiPath(path)) return [];
  return [
    {
      path,
      title: boundedString(titleValue, 160) || titleFromPath(path),
      action,
    },
  ];
}

function parseJsonRecord(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.includes("[truncated]")) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function resultString(result: Record<string, unknown>, key: string) {
  return typeof result[key] === "string" ? result[key] : null;
}

function boundedNullableString(value: unknown, maxLength: number) {
  const normalized = boundedString(value, maxLength);
  return normalized || null;
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function titleFromPath(path: string) {
  const slug = path.split("/").filter(Boolean).at(-1) ?? path;
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, 160);
}

function firstPageRef(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function encodeActivityCursor(createdAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString(
    "base64url",
  );
}

function decodeActivityCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    const record = asRecord(value);
    const createdAt = typeof record?.createdAt === "string" ? new Date(record.createdAt) : null;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!createdAt || !Number.isFinite(createdAt.getTime()) || !id || id.length > 128) {
      throw new Error("invalid");
    }
    return { createdAt, id };
  } catch {
    throw new CoreError("invalid_argument", "The Wiki activity cursor is invalid.");
  }
}
