import { getAppUrl } from "@opencompany/agent/app-url";
import { captureIntegrationAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import {
  appendSlackIntegrationStatus,
  buildSlackAuthorizationUrl,
  createSlackIntegrationState,
  exchangeSlackCode,
  fetchSlackIdentity,
  isSlackIntegrationConfigured,
  verifySlackIntegrationState,
} from "@opencompany/agent/integrations/slack";
import { verifySlackEventSignature } from "@opencompany/agent/integrations/slack-signature";
import {
  connectSlackIntegration,
  loadIntegrationCredential,
  markIntegrationStatus,
} from "@opencompany/db/integrations";
import type { SlackChannelType } from "@opencompany/db/product-schema";
import {
  insertSlackMessageEvents,
  listEnabledSlackBrainSourceRoutes,
  listEnabledSlackWikiSourceRoutes,
  listSlackIntegrationsForTeam,
  type SlackMessageEventInsert,
  slackSelectedConversationIds,
} from "@opencompany/db/slack";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "slack-ingress" });

type DbLike = any;

// Provider ingress composition for the Slack user-token ingestion app: the
// OAuth connect flow and the Events API webhook that buffers channel/DM
// messages for the runner's flush worker. Public URLs stay on the web origin
// as relays, so no Slack app configuration changes. The separate Slack answer
// bot has its own API-owned ingress and runner-owned answer pipeline.
export type SlackIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  webhook(request: Request): Promise<Response>;
};

export function createSlackIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
}): SlackIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
    webhook: (request) => handleWebhook(input, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier };

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

async function handleStart(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isSlackIntegrationConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createSlackIntegrationState({
    userWorkosId: session.userId,
    returnTo,
  });
  return sessionRedirect(session, buildSlackAuthorizationUrl(state));
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifySlackIntegrationState>;
  try {
    state = verifySlackIntegrationState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL("/settings?integration=slack&setup=error&reason=invalid_state", getAppUrl()),
    );
  }

  if (state.userWorkosId !== session.userId) {
    return statusRedirect(session, state.returnTo, "error", "session_mismatch");
  }
  if (!isSlackIntegrationConfigured()) {
    return statusRedirect(session, state.returnTo, "error", "not_configured");
  }
  if (url.searchParams.get("error")) {
    return statusRedirect(session, state.returnTo, "error", "slack_denied");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return statusRedirect(session, state.returnTo, "error", "missing_code");
  }

  try {
    const oauth = await exchangeSlackCode(code);
    const identity = await fetchSlackIdentity({
      accessToken: oauth.accessToken,
      authedUserId: oauth.authedUserId,
    });

    await connectSlackIntegration({
      userWorkosId: session.userId,
      teamId: oauth.teamId,
      teamName: oauth.teamName,
      teamDomain: identity.teamDomain,
      authedUserId: oauth.authedUserId,
      accountName: identity.userName,
      accountEmail: identity.userEmail,
      accessToken: oauth.accessToken,
      scopes: oauth.scopes,
      db: input.db,
    });
    await captureIntegrationAddedAnalytics({
      userWorkosId: session.userId,
      workspaceId: session.workspaceId,
      provider: "slack",
    });

    return statusRedirect(session, state.returnTo, "connected");
  } catch (error) {
    logger.warn("Slack integration connection failed", {
      event: "goat.slack_integration_callback_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return statusRedirect(session, state.returnTo, "error", "connection_sync_failed");
  }
}

async function handleWebhook(input: IngressInput, request: Request): Promise<Response> {
  const rawBody = await request.text();
  const verified = verifySlackEventSignature({
    rawBody,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
  });
  if (!verified) {
    return Response.json({ error: "Invalid Slack signature." }, { status: 401 });
  }

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (envelope.type === "url_verification") {
    return Response.json({ challenge: envelope.challenge ?? "" });
  }

  // Slack disables event delivery for apps that keep failing, so after the
  // signature check every path acks with 200 — errors are logged, not surfaced.
  try {
    if (envelope.type === "event_callback" && envelope.event && envelope.team_id) {
      const retryNum = request.headers.get("x-slack-retry-num");
      if (retryNum) {
        logger.warn("Slack retried event delivery", {
          event: "goat.slack_event_retried",
          retry_num: retryNum,
          retry_reason: request.headers.get("x-slack-retry-reason"),
          event_type: envelope.event.type,
        });
      }
      return Response.json(await handleEventCallback(input.db, envelope.team_id, envelope.event));
    }
  } catch (error) {
    logger.error("Failed to process Slack event", {
      event: "goat.slack_event_failed",
      event_type: envelope.event?.type,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }

  return Response.json({ ok: true });
}

async function handleEventCallback(db: DbLike, teamId: string, event: Record<string, unknown>) {
  if (event.type === "tokens_revoked" || event.type === "app_uninstalled") {
    return await handleRevocation(db, teamId, event);
  }
  if (event.type === "message") {
    return await handleMessage(db, teamId, event);
  }
  return { ok: true, ignored: true };
}

async function handleRevocation(db: DbLike, teamId: string, event: Record<string, unknown>) {
  const integrations = await listSlackIntegrationsForTeam(teamId, db);
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
        db,
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
      db,
    });
    marked += 1;
  }
  return { ok: true, marked };
}

async function handleMessage(db: DbLike, teamId: string, event: Record<string, unknown>) {
  const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
  const channelId = typeof event.channel === "string" ? event.channel : null;
  const channelType = typeof event.channel_type === "string" ? event.channel_type : null;
  const messageTs = typeof event.ts === "string" ? event.ts : null;
  const slackUserId = typeof event.user === "string" ? event.user : null;

  if (!INGESTED_MESSAGE_SUBTYPES.has(subtype)) {
    if (subtype && !KNOWN_DROPPED_SUBTYPES.has(subtype)) {
      logger.warn("Dropping Slack message with unknown subtype", {
        event: "goat.slack_event_unknown_subtype",
        subtype,
      });
    }
    return { ok: true, dropped: true };
  }
  if (event.bot_id || !slackUserId) return { ok: true, dropped: true };
  if (!channelId || !messageTs || !channelType || !SLACK_CHANNEL_TYPES.has(channelType)) {
    return { ok: true, dropped: true };
  }

  const integrations = await listSlackIntegrationsForTeam(teamId, db);
  const connected = integrations.filter((integration) => integration.status === "connected");
  if (connected.length === 0) return { ok: true, dropped: true };

  const integrationIds = connected.map((integration) => integration.id);
  const [brainRoutes, wikiRoutes] = await Promise.all([
    listEnabledSlackBrainSourceRoutes(integrationIds, db),
    listEnabledSlackWikiSourceRoutes(integrationIds, db),
  ]);
  const matchedIntegrationIds = new Set(
    [...brainRoutes, ...wikiRoutes]
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

  const buffered = await insertSlackMessageEvents(inserts, db);
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

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendSlackIntegrationStatus(returnTo, status, reason), getAppUrl()),
  );
}
