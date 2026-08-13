import { connectGoatSlackBotIntegration } from "@opencompany/db/goat-integrations";
import { getGoatAppUrl } from "@opencompany/goat-agent/app-url";
import {
  appendGoatSlackBotSetupStatus,
  buildGoatSlackBotAuthorizationUrl,
  createGoatSlackBotState,
  exchangeGoatSlackBotCode,
  isGoatSlackBotConfigured,
  verifyGoatSlackBotState,
} from "@opencompany/goat-agent/integrations/slack-bot";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "slack-bot-ingress" });

type DbLike = any;

// Provider ingress composition for the Slack answer-bot install: a second,
// separate Slack app from the user-token ingestion connection, installed once
// per Goat workspace by an admin. Only the OAuth start/callback moved here;
// the bot events webhook stays in web until the universal-Chat slice.
export type SlackBotIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
};

export function createSlackBotIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
}): SlackBotIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier };

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
