import { getAppUrl } from "@opencompany/agent/app-url";
import {
  appendSlackBotSetupStatus,
  buildSlackBotAuthorizationUrl,
  createSlackBotState,
  exchangeSlackBotCode,
  isSlackBotConfigured,
  verifySlackBotState,
} from "@opencompany/agent/integrations/slack-bot";
import { verifySlackEventSignature } from "@opencompany/agent/integrations/slack-signature";
import { connectSlackBotIntegration } from "@opencompany/db/integrations";
import {
  enqueueSlackDirectMessage,
  enqueueSlackThreadReply,
} from "@opencompany/db/session-subscriptions";
import { markSlackBotIntegrationStatusForTeam } from "@opencompany/db/slack-bot";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";
import type { RunnerClient } from "./runner-client";

const logger = createLogger({ service: "opencompany-api", runtime: "slack-bot-ingress" });

type DbLike = any;

// Provider ingress composition for the Slack answer-bot app. The API owns the
// public OAuth and webhook boundaries; claimed answer work is dispatched to
// the runner without forwarding the bot credential.
export type SlackBotIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  webhook(request: Request): Promise<Response>;
};

export function createSlackBotIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
  runner: RunnerClient;
}): SlackBotIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
    webhook: (request) => handleWebhook(input, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier; runner: RunnerClient };

type SlackEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: Record<string, unknown>;
};

async function handleStart(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings/workspace/slack";

  if (session.role !== "admin") {
    return statusRedirect(session, returnTo, "error", "admin_required");
  }
  if (!isSlackBotConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createSlackBotState({
    userWorkosId: session.userId,
    workspaceId: session.workspaceId,
    returnTo,
  });
  return sessionRedirect(session, buildSlackBotAuthorizationUrl(state));
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifySlackBotState>;
  try {
    state = verifySlackBotState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL(
        "/settings/workspace/slack?integration=slack_bot&setup=error&reason=invalid_state",
        getAppUrl(),
      ),
    );
  }

  // The state must have been minted for this user in this workspace, and the
  // completing session must still hold the admin role.
  if (
    state.userWorkosId !== session.userId ||
    state.workspaceId !== session.workspaceId ||
    session.role !== "admin"
  ) {
    return statusRedirect(session, state.returnTo, "error", "session_mismatch");
  }
  if (!isSlackBotConfigured()) {
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
    const oauth = await exchangeSlackBotCode(code);

    await connectSlackBotIntegration({
      userWorkosId: session.userId,
      workspaceId: session.workspaceId,
      teamId: oauth.teamId,
      teamName: oauth.teamName,
      botUserId: oauth.botUserId,
      accessToken: oauth.accessToken,
      scopes: oauth.scopes,
      db: input.db,
    });

    return statusRedirect(session, state.returnTo, "connected");
  } catch (error) {
    logger.warn("Slack bot connection failed", {
      event: "goat.slack_bot_callback_failed",
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
    secret: process.env.OPENCOMPANY_SLACK_BOT_SIGNING_SECRET,
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

  // Acknowledge only after durable inbox persistence.
  try {
    if (envelope.type === "event_callback" && envelope.event && envelope.team_id) {
      const retryNum = request.headers.get("x-slack-retry-num");
      if (retryNum) {
        logger.warn("Slack retried answer-bot event delivery", {
          event: "goat.slack_bot_event_retried",
          retry_num: retryNum,
          retry_reason: request.headers.get("x-slack-retry-reason"),
          event_type: envelope.event.type,
        });
      }
      return Response.json(
        await handleEventCallback(input, envelope.team_id, envelope.event_id, envelope.event),
      );
    }
  } catch (error) {
    logger.error("Failed to dispatch Slack answer-bot event", {
      event: "goat.slack_bot_event_dispatch_failed",
      event_type: envelope.event?.type,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "Event persistence failed." }, { status: 503 });
  }

  return Response.json({ ok: true });
}

async function handleEventCallback(
  input: IngressInput,
  teamId: string,
  eventId: string | undefined,
  event: Record<string, unknown>,
) {
  if (event.type === "tokens_revoked" || event.type === "app_uninstalled") {
    await markSlackBotIntegrationStatusForTeam(
      {
        teamId,
        status: "needs_reauth",
        statusReason:
          event.type === "app_uninstalled"
            ? "The opencompany Slack app was uninstalled from the workspace."
            : "The Slack bot token was revoked.",
      },
      input.db,
    );
    return { ok: true };
  }

  if (event.type !== "message" || event.bot_id || event.subtype || event.hidden || event.files) {
    return { ok: true, ignored: true };
  }
  const channelId = typeof event.channel === "string" ? event.channel : "";
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : "";
  const messageTs = typeof event.ts === "string" ? event.ts : "";
  const slackUserId = typeof event.user === "string" ? event.user : "";
  const text = typeof event.text === "string" ? event.text.trim() : "";
  // A public channel is only ever joined mid-thread; a direct message with the bot has no other
  // participants, so its first message is what opens the session and its replies continue it.
  const directMessage = channelId.startsWith("D") && event.channel_type === "im";
  const channelReply = channelId.startsWith("C") && event.channel_type === "channel";
  if (!eventId || !messageTs || !slackUserId || !text || text.length > 12000) {
    return { ok: true, ignored: true };
  }
  if (directMessage && (!threadTs || threadTs === messageTs)) {
    const accepted = await enqueueSlackDirectMessage((query) => input.db.execute(query), {
      teamId,
      eventId,
      channelId,
      messageTs,
      slackUserId,
      text,
    });
    return { ok: true, accepted };
  }
  if ((!directMessage && !channelReply) || !threadTs || threadTs === messageTs) {
    return { ok: true, ignored: true };
  }
  const accepted = await enqueueSlackThreadReply((query) => input.db.execute(query), {
    teamId,
    eventId,
    channelId,
    threadTs,
    messageTs,
    slackUserId,
    text,
  });
  return { ok: true, accepted };
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendSlackBotSetupStatus(returnTo, status, reason), getAppUrl()),
  );
}
