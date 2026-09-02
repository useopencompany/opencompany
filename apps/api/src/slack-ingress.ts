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
import { connectSlackIntegration } from "@opencompany/db/integrations";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "slack-oauth" });

type DbLike = any;

// OAuth boundary for the official Slack MCP plugin. Slack event ingestion was
// retired; the separate workspace answer bot owns its own OAuth and webhook.
export type SlackIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
};

export function createSlackIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: (input: {
    userWorkosId: string;
    workspaceIds: string[];
  }) => Promise<void>;
}): SlackIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
  };
}

type IngressInput = {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: (input: {
    userWorkosId: string;
    workspaceIds: string[];
  }) => Promise<void>;
};

async function handleStart(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings/plugins/slack";

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
      new URL(
        "/settings/plugins/slack?integration=slack&setup=error&reason=invalid_state",
        getAppUrl(),
      ),
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
    if (input.refreshPluginRegistrations) {
      try {
        await input.refreshPluginRegistrations({
          userWorkosId: session.userId,
          workspaceIds: session.workspaces.map((entry) => entry.workspace.id),
        });
      } catch (error) {
        logger.warn("Slack plugin discovery refresh after connection failed", {
          event: "goat.slack_plugin_reconnect_refresh_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return statusRedirect(session, state.returnTo, "connected");
  } catch (error) {
    logger.warn("Slack plugin connection failed", {
      event: "goat.slack_plugin_callback_failed",
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
    new URL(appendSlackIntegrationStatus(returnTo, status, reason), getAppUrl()),
  );
}
