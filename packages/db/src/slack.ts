import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  brainSources,
  type IntegrationStatus,
  integrations,
  type SlackChannelType,
  slackMessageEvents,
} from "./product-schema";

type DbLike = any;

export type SlackConversationRef = {
  id: string;
  name: string;
};

// The routing contract between the channel picker, the events webhook, and the
// flush worker: a message is buffered/ingested only when its channel id appears
// in the enabled brain-source config for the integration.
export type SlackBrainSourceConfig = {
  channels?: SlackConversationRef[];
  dms?: SlackConversationRef[];
};

export type SlackIntegrationForTeam = {
  id: string;
  userWorkosId: string;
  status: IntegrationStatus;
};

export type SlackBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: SlackBrainSourceConfig;
};

export type SlackMessageEventInsert = {
  integrationId: string;
  userWorkosId: string;
  teamId: string;
  channelId: string;
  channelType: SlackChannelType;
  messageTs: string;
  threadTs?: string | null;
  slackUserId?: string | null;
  subtype?: string | null;
  text: string;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseSlackBrainSourceConfig(value: unknown): SlackBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const channels = parseConversationRefs(record.channels);
  const dms = parseConversationRefs(record.dms);
  return {
    ...(channels ? { channels } : {}),
    ...(dms ? { dms } : {}),
  };
}

export function slackSelectedConversationIds(config: SlackBrainSourceConfig): Set<string> {
  const ids = new Set<string>();
  for (const ref of config.channels ?? []) ids.add(ref.id);
  for (const ref of config.dms ?? []) ids.add(ref.id);
  return ids;
}

export async function listSlackIntegrationsForTeam(
  teamId: string,
  db: DbLike = getDb(),
): Promise<SlackIntegrationForTeam[]> {
  return await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
    })
    .from(integrations)
    .where(and(eq(integrations.provider, "slack"), eq(integrations.externalId, teamId)));
}

export async function listEnabledSlackBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<SlackBrainSourceRoute[]> {
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
        eq(brainSources.provider, "slack"),
        eq(brainSources.enabled, true),
        inArray(brainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseSlackBrainSourceConfig(row.config),
  }));
}

export async function insertSlackMessageEvents(
  events: readonly SlackMessageEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // Slack redelivers events on retry; the unique (integration, channel, ts)
  // index makes redeliveries no-ops.
  const rows = await db
    .insert(slackMessageEvents)
    .values(
      events.map((event) => ({
        id: newSlackMessageEventId(),
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
    .returning({ id: slackMessageEvents.id });
  return rows.length;
}

export function newSlackMessageEventId() {
  return `gslkmsg_${randomUUID().replace(/-/g, "")}`;
}

export function newSlackConversationWindowId() {
  return `gslkwin_${randomUUID().replace(/-/g, "")}`;
}

function parseConversationRefs(value: unknown): SlackConversationRef[] | undefined {
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
