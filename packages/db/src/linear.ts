import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  brainSources,
  type IntegrationStatus,
  integrations,
  type LinearEventAction,
  type LinearEventEntityType,
  linearIssueEvents,
} from "./schema";

type DbLike = any;

// The Linear MCP connector reuses provider "linear" with this sentinel external
// id; ingestion integrations key on the Linear organization id instead, so the
// two kinds of rows never collide.
export const GOAT_LINEAR_MCP_EXTERNAL_ID = "linear_mcp";

export type LinearTeamRef = {
  id: string;
  key?: string;
  name: string;
};

export const GOAT_LINEAR_EVENT_TYPES = [
  "issue_created",
  "issue_updated",
  "issue_status_changed",
  "issue_removed",
  "comment_created",
  "comment_updated",
  "comment_removed",
] as const;

export type LinearEventType = (typeof GOAT_LINEAR_EVENT_TYPES)[number];

export type LinearEventRef = {
  id: LinearEventType;
};

// The routing contract between the team picker, the events webhook, and the
// flush worker: issue activity is buffered/ingested only when its team id
// and derived event type appear in the enabled brain-source config for the
// integration.
export type LinearBrainSourceConfig = {
  teams?: LinearTeamRef[];
  events?: LinearEventRef[];
};

export type LinearIntegrationForOrganization = {
  id: string;
  userWorkosId: string;
  status: IntegrationStatus;
};

export type LinearBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: LinearBrainSourceConfig;
};

export type LinearIssueEventInsert = {
  integrationId: string;
  userWorkosId: string;
  organizationId: string;
  teamId?: string | null;
  issueId: string;
  deliveryId: string;
  entityType: LinearEventEntityType;
  action: LinearEventAction;
  issueTitle?: string | null;
  actorName?: string | null;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseLinearBrainSourceConfig(value: unknown): LinearBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const teams = parseTeamRefs(record.teams);
  const events = parseEventRefs(record.events);
  return {
    ...(teams ? { teams } : {}),
    ...(events ? { events } : {}),
  };
}

export function linearSelectedTeamIds(config: LinearBrainSourceConfig): Set<string> {
  const ids = new Set<string>();
  for (const ref of config.teams ?? []) ids.add(ref.id);
  return ids;
}

export function linearSelectedEventTypes(
  config: LinearBrainSourceConfig,
): Set<LinearEventType> | null {
  if (!config.events) return null;
  return new Set(config.events.map((ref) => ref.id));
}

export function linearRouteMatchesEvent(
  config: LinearBrainSourceConfig,
  eventType: LinearEventType,
) {
  const selected = linearSelectedEventTypes(config);
  return selected === null || selected.has(eventType);
}

export function linearEventTypeFor(input: {
  entityType: LinearEventEntityType;
  action: LinearEventAction;
  updatedFrom?: Record<string, unknown> | null;
}): LinearEventType | null {
  if (input.entityType === "comment") {
    if (input.action === "create") return "comment_created";
    if (input.action === "update") return "comment_updated";
    if (input.action === "remove") return "comment_removed";
    return null;
  }

  if (input.action === "create") return "issue_created";
  if (input.action === "remove") return "issue_removed";
  if (input.action === "update") {
    return linearUpdatedFromHasStatusChange(input.updatedFrom)
      ? "issue_status_changed"
      : "issue_updated";
  }
  return null;
}

export async function listLinearIntegrationsForOrganization(
  organizationId: string,
  db: DbLike = getDb(),
): Promise<LinearIntegrationForOrganization[]> {
  return await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, "linear"),
        // Ingestion rows key external_id on the Linear organization id, so MCP
        // rows (external_id "linear_mcp") can never match here.
        eq(integrations.externalId, organizationId),
      ),
    );
}

export async function listEnabledLinearBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<LinearBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: brainSources.integrationId,
      brainRef: brainSources.brainId,
      config: brainSources.config,
    })
    .from(brainSources)
    .where(
      and(
        eq(brainSources.provider, "linear"),
        eq(brainSources.enabled, true),
        inArray(brainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseLinearBrainSourceConfig(row.config),
  }));
}

export async function insertLinearIssueEvents(
  events: readonly LinearIssueEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // Linear redelivers webhooks on retry; the unique (integration, delivery id)
  // index makes redeliveries no-ops.
  const rows = await db
    .insert(linearIssueEvents)
    .values(
      events.map((event) => ({
        id: newLinearIssueEventId(),
        integrationId: event.integrationId,
        userWorkosId: event.userWorkosId,
        organizationId: event.organizationId,
        teamId: event.teamId ?? null,
        issueId: event.issueId,
        deliveryId: event.deliveryId,
        entityType: event.entityType,
        action: event.action,
        issueTitle: event.issueTitle ?? null,
        actorName: event.actorName ?? null,
        payload: event.payload,
        eventTime: event.eventTime,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: linearIssueEvents.id });
  return rows.length;
}

export function newLinearIssueEventId() {
  return `glinevt_${randomUUID().replace(/-/g, "")}`;
}

export function newLinearIssueWindowId() {
  return `glinwin_${randomUUID().replace(/-/g, "")}`;
}

function parseTeamRefs(value: unknown): LinearTeamRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const key = typeof record.key === "string" ? record.key.trim() : "";
    return [{ id, name: name || id, ...(key ? { key } : {}) }];
  });
  return refs.length > 0 ? refs : undefined;
}

function parseEventRefs(value: unknown): LinearEventRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<LinearEventType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isLinearEventType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs;
}

function isLinearEventType(value: unknown): value is LinearEventType {
  return (
    typeof value === "string" && (GOAT_LINEAR_EVENT_TYPES as readonly string[]).includes(value)
  );
}

function linearUpdatedFromHasStatusChange(updatedFrom: Record<string, unknown> | null | undefined) {
  if (!updatedFrom) return false;
  return ["stateId", "state", "status", "statusId", "stateType"].some((key) => key in updatedFrom);
}
