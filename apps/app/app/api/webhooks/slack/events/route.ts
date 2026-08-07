import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import type { SlackChannelType } from "@opencompany/db/schema";
import {
  insertSlackMessageEvents,
  listEnabledSlackBrainSourceRoutes,
  listSlackIntegrationsForTeam,
  type SlackMessageEventInsert,
  slackSelectedConversationIds,
} from "@opencompany/db/slack";
import { NextResponse } from "next/server";
import { verifySlackEventSignature } from "@/lib/integrations/slack-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Message subtypes that carry conversation content. Everything else
// (message_changed, message_deleted, channel_join, bot_message, ...) is noise
// for brain ingestion.
const INGESTED_MESSAGE_SUBTYPES = new Set<string | undefined>([
  undefined,
  "file_share",
  "thread_broadcast",
]);

const SLACK_CHANNEL_TYPES = new Set<string>(["channel", "group", "im", "mpim"]);

type SlackEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: Record<string, unknown>;
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  const verified = verifySlackEventSignature({
    rawBody,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
  });
  if (!verified) {
    return NextResponse.json({ error: "Invalid Slack signature." }, { status: 401 });
  }

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (envelope.type === "url_verification") {
    return NextResponse.json({ challenge: envelope.challenge ?? "" });
  }

  // Slack disables event delivery for apps that keep failing, so after the
  // signature check every path acks with 200 — errors are logged, not surfaced.
  try {
    if (envelope.type === "event_callback" && envelope.event && envelope.team_id) {
      const retryNum = request.headers.get("x-slack-retry-num");
      if (retryNum) {
        console.warn("[goat-slack] Slack retried event delivery", {
          retryNum,
          retryReason: request.headers.get("x-slack-retry-reason"),
          eventType: envelope.event.type,
        });
      }
      return NextResponse.json(await handleEventCallback(envelope.team_id, envelope.event));
    }
  } catch (error) {
    console.error("[goat-slack] Failed to process Slack event", {
      eventType: envelope.event?.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json({ ok: true });
}

async function handleEventCallback(teamId: string, event: Record<string, unknown>) {
  if (event.type === "tokens_revoked" || event.type === "app_uninstalled") {
    return await handleRevocation(teamId, event);
  }
  if (event.type === "message") {
    return await handleMessage(teamId, event);
  }
  return { ok: true, ignored: true };
}

async function handleRevocation(teamId: string, event: Record<string, unknown>) {
  const integrations = await listSlackIntegrationsForTeam(teamId);
  const revokedUserIds = event.type === "tokens_revoked" ? extractRevokedOauthUserIds(event) : null;

  let marked = 0;
  for (const integration of integrations) {
    if (integration.status === "disconnected") continue;
    if (revokedUserIds) {
      const credential = await loadIntegrationCredential({
        userWorkosId: integration.userWorkosId,
        integrationId: integration.id,
        provider: "slack",
        kind: "oauth_token",
      }).catch(() => null);
      const authedUserId = credential?.payload.authed_user_id;
      if (typeof authedUserId !== "string" || !revokedUserIds.has(authedUserId)) continue;
    }
    await markIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: "slack",
      status: "needs_reauth",
      statusReason:
        event.type === "app_uninstalled"
          ? "The Slack app was uninstalled from the workspace."
          : "The Slack token was revoked.",
    });
    marked += 1;
  }
  return { ok: true, marked };
}

async function handleMessage(teamId: string, event: Record<string, unknown>) {
  const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
  const channelId = typeof event.channel === "string" ? event.channel : null;
  const channelType = typeof event.channel_type === "string" ? event.channel_type : null;
  const messageTs = typeof event.ts === "string" ? event.ts : null;
  const slackUserId = typeof event.user === "string" ? event.user : null;

  if (!INGESTED_MESSAGE_SUBTYPES.has(subtype)) {
    if (subtype && !KNOWN_DROPPED_SUBTYPES.has(subtype)) {
      console.warn("[goat-slack] Dropping message with unknown subtype", { subtype });
    }
    return { ok: true, dropped: true };
  }
  if (event.bot_id || !slackUserId) return { ok: true, dropped: true };
  if (!channelId || !messageTs || !channelType || !SLACK_CHANNEL_TYPES.has(channelType)) {
    return { ok: true, dropped: true };
  }

  const integrations = await listSlackIntegrationsForTeam(teamId);
  const connected = integrations.filter((integration) => integration.status === "connected");
  if (connected.length === 0) return { ok: true, dropped: true };

  const routes = await listEnabledSlackBrainSourceRoutes(
    connected.map((integration) => integration.id),
  );
  const matchedIntegrationIds = new Set(
    routes
      .filter((route) => slackSelectedConversationIds(route.config).has(channelId))
      .map((route) => route.integrationId),
  );
  if (matchedIntegrationIds.size === 0) return { ok: true, dropped: true };

  const eventTimeSeconds = Number(messageTs);
  const inserts: SlackMessageEventInsert[] = connected
    .filter((integration) => matchedIntegrationIds.has(integration.id))
    .map((integration) => ({
      integrationId: integration.id,
      userWorkosId: integration.userWorkosId,
      teamId,
      channelId,
      channelType: channelType as SlackChannelType,
      messageTs,
      threadTs: typeof event.thread_ts === "string" ? event.thread_ts : null,
      slackUserId,
      subtype: subtype ?? null,
      text: typeof event.text === "string" ? event.text : "",
      payload: event,
      eventTime: Number.isFinite(eventTimeSeconds) ? new Date(eventTimeSeconds * 1000) : new Date(),
    }));

  const buffered = await insertSlackMessageEvents(inserts);
  return { ok: true, buffered };
}

// Subtypes we expect to see and intentionally skip; anything outside this list
// gets logged once per delivery so new subtypes surface in telemetry.
const KNOWN_DROPPED_SUBTYPES = new Set([
  "bot_message",
  "message_changed",
  "message_deleted",
  "message_replied",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "huddle_thread",
  "assistant_app_thread",
]);

function extractRevokedOauthUserIds(event: Record<string, unknown>): Set<string> | null {
  const tokens = event.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const oauth = (tokens as Record<string, unknown>).oauth;
  if (!Array.isArray(oauth)) return null;
  const ids = oauth.filter((value): value is string => typeof value === "string");
  return ids.length > 0 ? new Set(ids) : null;
}
