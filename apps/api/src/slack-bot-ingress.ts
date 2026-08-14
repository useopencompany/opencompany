import { connectGoatSlackBotIntegration } from "@opencompany/db/goat-integrations";
import {
  claimGoatSlackBotEvent,
  getGoatSlackBotThreadParticipation,
  markGoatSlackBotIntegrationStatusForTeam,
  releaseGoatSlackBotEvent,
} from "@opencompany/db/goat-slack-bot";
import { getGoatAppUrl } from "@opencompany/goat-agent/app-url";
import {
  appendGoatSlackBotSetupStatus,
  buildGoatSlackBotAuthorizationUrl,
  createGoatSlackBotState,
  exchangeGoatSlackBotCode,
  isGoatSlackBotConfigured,
  verifyGoatSlackBotState,
} from "@opencompany/goat-agent/integrations/slack-bot";
import { GOAT_SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION } from "@opencompany/goat-agent/integrations/slack-bot-events";
import { mentionsOtherHuman } from "@opencompany/goat-agent/integrations/slack-bot-format";
import { verifyGoatSlackEventSignature } from "@opencompany/goat-agent/integrations/slack-signature";
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
  if (!isGoatSlackBotConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createGoatSlackBotState({
    userWorkosId: session.userId,
    workspaceId: session.workspaceId,
    returnTo,
  });
  return sessionRedirect(session, buildGoatSlackBotAuthorizationUrl(state));
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifyGoatSlackBotState>;
  try {
    state = verifyGoatSlackBotState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL(
        "/settings/workspace/slack?integration=slack_bot&setup=error&reason=invalid_state",
        getGoatAppUrl(),
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
  if (!isGoatSlackBotConfigured()) {
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
    const oauth = await exchangeGoatSlackBotCode(code);

    await connectGoatSlackBotIntegration({
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
  const verified = verifyGoatSlackEventSignature({
    rawBody,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    secret: process.env.GOAT_SLACK_BOT_SIGNING_SECRET,
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

  // Slack disables event delivery after repeated failures, so every verified
  // event path is acknowledged. A failed runner dispatch releases the claim
  // so a later duplicate delivery can be claimed without exposing the backend
  // failure to Slack.
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
    await markGoatSlackBotIntegrationStatusForTeam(
      {
        teamId,
        status: "needs_reauth",
        statusReason:
          event.type === "app_uninstalled"
            ? "The OpenCompany Slack app was uninstalled from the workspace."
            : "The Slack bot token was revoked.",
      },
      input.db,
    );
    return { ok: true };
  }

  if (event.type !== "app_mention" && event.type !== "message") {
    return { ok: true, ignored: true };
  }

  const channelId = typeof event.channel === "string" ? event.channel : null;
  const messageTs = typeof event.ts === "string" ? event.ts : null;
  const slackUserId = typeof event.user === "string" ? event.user : null;
  const text = typeof event.text === "string" ? event.text : "";
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
  if (event.bot_id || event.subtype || !slackUserId || !channelId || !messageTs) {
    return { ok: true, dropped: true };
  }

  let kind: "mention" | "follow_up" | "dm";
  if (event.type === "app_mention") {
    kind = "mention";
  } else if (event.channel_type === "im" || channelId.startsWith("D")) {
    kind = "dm";
  } else {
    // A bot mention arrives separately as app_mention, while a human mention
    // addresses somebody else. Neither should be answered by this delivery.
    if (!threadTs) return { ok: true, ignored: true };
    if (mentionsOtherHuman(text, null)) return { ok: true, ignored: true };
    const participation = await getGoatSlackBotThreadParticipation(
      { teamId, channelId, threadTs },
      input.db,
    );
    if (!participation) return { ok: true, ignored: true };
    kind = "follow_up";
  }

  if (!eventId) {
    logger.warn("Dropping Slack answer-bot event without event_id", {
      event: "goat.slack_bot_event_missing_id",
      team_id: teamId,
      channel_id: channelId,
      kind,
    });
    return { ok: true, dropped: true };
  }

  const claim = await claimGoatSlackBotEvent({ eventId, teamId }, input.db);
  if (!claim) return { ok: true, skipped: "duplicate" };

  try {
    await input.runner.postJson(
      "/internal/goat/slack-bot/events",
      {
        schemaVersion: GOAT_SLACK_BOT_EVENT_COMMAND_SCHEMA_VERSION,
        eventId: claim.eventId,
        claimId: claim.claimId,
        kind,
        input: { teamId, channelId, messageTs, threadTs, text, slackUserId },
      },
      { errorFormat: "error-message" },
    );
  } catch (error) {
    await releaseGoatSlackBotEvent(claim, input.db).catch((releaseError) => {
      logger.error("Failed to release undispatched Slack bot event", {
        event: "goat.slack_bot_event_dispatch_release_failed",
        event_id: eventId,
        error_message: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    });
    throw error;
  }
  return { ok: true };
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendGoatSlackBotSetupStatus(returnTo, status, reason), getGoatAppUrl()),
  );
}
