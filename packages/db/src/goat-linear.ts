import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatIntegrationStatus,
  type GoatLinearEventAction,
  type GoatLinearEventEntityType,
  goatBrainSources,
  goatIntegrations,
  goatLinearIssueEvents,
} from "./goat-schema";

type DbLike = any;

// The Linear MCP connector reuses provider "linear" with this sentinel external
// id; ingestion integrations key on the Linear organization id instead, so the
// two kinds of rows never collide.
export const GOAT_LINEAR_MCP_EXTERNAL_ID = "linear_mcp";

export type GoatLinearTeamRef = {
  id: string;
  key?: string;
  name: string;
};

// The routing contract between the team picker, the events webhook, and the
// flush worker: issue activity is buffered/ingested only when its team id
// appears in the enabled brain-source config for the integration.
export type GoatLinearBrainSourceConfig = {
  teams?: GoatLinearTeamRef[];
};

export type GoatLinearIntegrationForOrganization = {
  id: string;
  userWorkosId: string;
  status: GoatIntegrationStatus;
};

export type GoatLinearBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: GoatLinearBrainSourceConfig;
};

export type GoatLinearIssueEventInsert = {
  integrationId: string;
  userWorkosId: string;
  organizationId: string;
  teamId?: string | null;
  issueId: string;
  deliveryId: string;
  entityType: GoatLinearEventEntityType;
  action: GoatLinearEventAction;
  issueTitle?: string | null;
  actorName?: string | null;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseGoatLinearBrainSourceConfig(value: unknown): GoatLinearBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const teams = parseTeamRefs(record.teams);
  return teams ? { teams } : {};
}

export function goatLinearSelectedTeamIds(config: GoatLinearBrainSourceConfig): Set<string> {
  const ids = new Set<string>();
  for (const ref of config.teams ?? []) ids.add(ref.id);
  return ids;
}

export async function listGoatLinearIntegrationsForOrganization(
  organizationId: string,
  db: DbLike = getDb(),
): Promise<GoatLinearIntegrationForOrganization[]> {
  return await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.provider, "linear"),
        // Ingestion rows key external_id on the Linear organization id, so MCP
        // rows (external_id "linear_mcp") can never match here.
        eq(goatIntegrations.externalId, organizationId),
      ),
    );
}

export async function listEnabledGoatLinearBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GoatLinearBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: goatBrainSources.integrationId,
      brainRef: goatBrainSources.brainId,
      config: goatBrainSources.config,
    })
    .from(goatBrainSources)
    .where(
      and(
        eq(goatBrainSources.provider, "linear"),
        eq(goatBrainSources.enabled, true),
        inArray(goatBrainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseGoatLinearBrainSourceConfig(row.config),
  }));
}

export async function insertGoatLinearIssueEvents(
  events: readonly GoatLinearIssueEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // Linear redelivers webhooks on retry; the unique (integration, delivery id)
  // index makes redeliveries no-ops.
  const rows = await db
    .insert(goatLinearIssueEvents)
    .values(
      events.map((event) => ({
        id: newGoatLinearIssueEventId(),
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
    .returning({ id: goatLinearIssueEvents.id });
  return rows.length;
}

export function newGoatLinearIssueEventId() {
  return `glinevt_${randomUUID().replace(/-/g, "")}`;
}

export function newGoatLinearIssueWindowId() {
  return `glinwin_${randomUUID().replace(/-/g, "")}`;
}

function parseTeamRefs(value: unknown): GoatLinearTeamRef[] | undefined {
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
