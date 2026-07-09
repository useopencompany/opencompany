import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatIntegrationStatus,
  type GoatSlackChannelType,
  goatBrainSources,
  goatIntegrations,
  goatSlackMessageEvents,
} from "./goat-schema";

type DbLike = any;

export type GoatSlackConversationRef = {
  id: string;
  name: string;
};

// The routing contract between the channel picker, the events webhook, and the
// flush worker: a message is buffered/ingested only when its channel id appears
// in the enabled brain-source config for the integration.
export type GoatSlackBrainSourceConfig = {
  channels?: GoatSlackConversationRef[];
  dms?: GoatSlackConversationRef[];
};

export type GoatSlackIntegrationForTeam = {
  id: string;
  userWorkosId: string;
  status: GoatIntegrationStatus;
};

export type GoatSlackBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: GoatSlackBrainSourceConfig;
};

export type GoatSlackMessageEventInsert = {
  integrationId: string;
  userWorkosId: string;
  teamId: string;
  channelId: string;
  channelType: GoatSlackChannelType;
  messageTs: string;
  threadTs?: string | null;
  slackUserId?: string | null;
  subtype?: string | null;
  text: string;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseGoatSlackBrainSourceConfig(value: unknown): GoatSlackBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const channels = parseConversationRefs(record.channels);
  const dms = parseConversationRefs(record.dms);
  return {
    ...(channels ? { channels } : {}),
    ...(dms ? { dms } : {}),
  };
}

export function goatSlackSelectedConversationIds(config: GoatSlackBrainSourceConfig): Set<string> {
  const ids = new Set<string>();
  for (const ref of config.channels ?? []) ids.add(ref.id);
  for (const ref of config.dms ?? []) ids.add(ref.id);
  return ids;
}

export async function listGoatSlackIntegrationsForTeam(
  teamId: string,
  db: DbLike = getDb(),
): Promise<GoatSlackIntegrationForTeam[]> {
  return await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(and(eq(goatIntegrations.provider, "slack"), eq(goatIntegrations.externalId, teamId)));
}

export async function listEnabledGoatSlackBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GoatSlackBrainSourceRoute[]> {
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
        eq(goatBrainSources.provider, "slack"),
        eq(goatBrainSources.enabled, true),
        inArray(goatBrainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseGoatSlackBrainSourceConfig(row.config),
  }));
}

export async function insertGoatSlackMessageEvents(
  events: readonly GoatSlackMessageEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // Slack redelivers events on retry; the unique (integration, channel, ts)
  // index makes redeliveries no-ops.
  const rows = await db
    .insert(goatSlackMessageEvents)
    .values(
      events.map((event) => ({
        id: newGoatSlackMessageEventId(),
        integrationId: event.integrationId,
        userWorkosId: event.userWorkosId,
        teamId: event.teamId,
        channelId: event.channelId,
        channelType: event.channelType,
        messageTs: event.messageTs,
        threadTs: event.threadTs ?? null,
        slackUserId: event.slackUserId ?? null,
        subtype: event.subtype ?? null,
        text: event.text,
        payload: event.payload,
        eventTime: event.eventTime,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: goatSlackMessageEvents.id });
  return rows.length;
}

export function newGoatSlackMessageEventId() {
  return `gslkmsg_${randomUUID().replace(/-/g, "")}`;
}

export function newGoatSlackConversationWindowId() {
  return `gslkwin_${randomUUID().replace(/-/g, "")}`;
}

function parseConversationRefs(value: unknown): GoatSlackConversationRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const name = typeof record.name === "string" ? record.name.trim() : "";
    return [{ id, name: name || id }];
  });
  return refs.length > 0 ? refs : undefined;
}
