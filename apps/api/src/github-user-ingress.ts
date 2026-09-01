import { getAppUrl } from "@opencompany/agent/app-url";
import { captureIntegrationAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import {
  appendGitHubUserIntegrationStatus,
  buildGitHubUserInstallUrl,
  createGitHubUserIntegrationState,
  exchangeGitHubUserCode,
  fetchGitHubUserIdentity,
  isGitHubUserIntegrationConfigured,
  verifyGitHubUserIntegrationState,
} from "@opencompany/agent/integrations/github-user";
import { connectGitHubUserIntegration } from "@opencompany/db/integrations";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "github-user-ingress" });

type DbLike = any;

export type GitHubUserIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
};

type RefreshPluginRegistrations = (input: {
  userWorkosId: string;
  workspaceIds: string[];
}) => Promise<void>;

export function createGitHubUserIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: RefreshPluginRegistrations;
}): GitHubUserIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
  };
}

type IngressInput = {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: RefreshPluginRegistrations;
};

async function handleStart(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGitHubUserIntegrationConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createGitHubUserIntegrationState({
    userWorkosId: session.userId,
    returnTo,
  });
  return sessionRedirect(session, buildGitHubUserInstallUrl(state));
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifyGitHubUserIntegrationState>;
  try {
    state = verifyGitHubUserIntegrationState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL("/settings?integration=github_user&setup=error&reason=invalid_state", getAppUrl()),
    );
  }

  if (state.userWorkosId !== session.userId) {
    return statusRedirect(session, state.returnTo, "error", "session_mismatch");
  }
  if (!isGitHubUserIntegrationConfigured()) {
    return statusRedirect(session, state.returnTo, "error", "not_configured");
  }
  if (url.searchParams.get("error")) {
    return statusRedirect(session, state.returnTo, "error", "github_user_denied");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return statusRedirect(session, state.returnTo, "error", "missing_code");
  }

  try {
    const tokens = await exchangeGitHubUserCode(code);
    const identity = await fetchGitHubUserIdentity(tokens.accessToken);
    await connectGitHubUserIntegration({
      userWorkosId: session.userId,
      githubUserId: identity.id,
      login: identity.login,
      name: identity.name,
      email: identity.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      tokenType: tokens.tokenType,
      db: input.db,
    });
    await captureIntegrationAddedAnalytics({
      userWorkosId: session.userId,
      workspaceId: session.workspaceId,
      provider: "github_user",
    });
    await refreshAfterConnection(input, session);
    return statusRedirect(session, state.returnTo, "connected");
  } catch (error) {
    logger.warn("GitHub user connection failed", {
      event: "opencompany.github_user_callback_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return statusRedirect(session, state.returnTo, "error", "connection_sync_failed");
  }
}

async function refreshAfterConnection(
  input: IngressInput,
  session: Extract<IngressSession, { kind: "actor" }>,
) {
  if (!input.refreshPluginRegistrations) return;
  try {
    await input.refreshPluginRegistrations({
      userWorkosId: session.userId,
      workspaceIds: session.workspaces.map((entry) => entry.workspace.id),
    });
  } catch (error) {
    logger.warn("Plugin discovery refresh after GitHub connection failed", {
      event: "opencompany.github_user_plugin_refresh_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
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
    new URL(appendGitHubUserIntegrationStatus(returnTo, status, reason), getAppUrl()),
  );
}
