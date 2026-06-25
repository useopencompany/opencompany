import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import {
  appendIntegrationStatus,
  buildGitHubUserAuthorizationUrl,
  createGitHubIntegrationState,
  exchangeGitHubUserCode,
  getGitHubWorkInstallation,
  isGitHubWorkIntegrationConfigured,
  listGitHubWorkInstallationRepositories,
  verifyGitHubIntegrationState,
  verifyGitHubUserInstallation,
} from "@/lib/integrations/github";
import { syncGitHubIntegrationRepositories } from "@/lib/integrations/service";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  // skipOnboarding: the onboarding integrations step opens this OAuth flow in a popup before
  // onboarding is marked complete; the default gate would bounce the popup to /onboarding.
  const current = await currentWorkspace({ requireAdmin: true, skipOnboarding: true });
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyGitHubIntegrationState(stateValue);
  } catch (error) {
    captureException(error, {
      event: "opencompany.github_integration_callback_failed",
      reason: "invalid_state",
    });
    logger.warn("GitHub integration callback rejected invalid state", {
      event: "opencompany.github_integration_callback_failed",
      reason: "invalid_state",
      has_state: Boolean(stateValue),
    });
    return NextResponse.redirect(
      new URL("/company/integrations?integration=github&setup=error", url),
    );
  }

  if (state.workspaceId !== current.workspace.id || state.userId !== current.user.id) {
    logger.warn("GitHub integration callback state did not match current session", {
      event: "opencompany.github_integration_callback_failed",
      reason: "state_session_mismatch",
      workspace_matches: state.workspaceId === current.workspace.id,
      user_matches: state.userId === current.user.id,
      intent: state.intent,
    });
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }

  if (!isGitHubWorkIntegrationConfigured()) {
    logger.error("GitHub integration callback reached without required configuration", {
      event: "opencompany.github_integration_callback_failed",
      reason: "not_configured",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      intent: state.intent,
    });
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }

  const installationId = state.installationId ?? url.searchParams.get("installation_id");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logger.warn("GitHub integration OAuth returned an error", {
      event: "opencompany.github_integration_callback_failed",
      reason: "oauth_error",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      intent: state.intent,
      installation_id: installationId,
      oauth_error: oauthError,
      oauth_error_description: url.searchParams.get("error_description"),
      oauth_error_uri: url.searchParams.get("error_uri"),
    });
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }

  if (!installationId) {
    logger.warn("GitHub integration callback missing installation id", {
      event: "opencompany.github_integration_callback_failed",
      reason: "missing_installation_id",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      intent: state.intent,
      has_code: Boolean(code),
      setup_action: url.searchParams.get("setup_action"),
    });
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }

  if (!code) {
    logger.info(
      "GitHub integration installation callback accepted; requesting user authorization",
      {
        event: "opencompany.github_integration_oauth_redirect",
        workspace_id: current.workspace.id,
        user_id: current.user.id,
        intent: state.intent,
        installation_id: installationId,
        setup_action: url.searchParams.get("setup_action"),
      },
    );
    const nextState = createGitHubIntegrationState({
      workspaceId: state.workspaceId,
      userId: state.userId,
      intent: state.intent,
      returnTo: state.returnTo,
      installationId,
    });
    return NextResponse.redirect(buildGitHubUserAuthorizationUrl(nextState));
  }

  try {
    logger.info("GitHub integration OAuth callback received", {
      event: "opencompany.github_integration_oauth_callback_received",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      intent: state.intent,
      installation_id: installationId,
    });

    const userToken = await exchangeGitHubUserCode(code);
    const verifiedInstallation = await verifyGitHubUserInstallation({ userToken, installationId });
    const installation = await getGitHubWorkInstallation({ installationId });
    const repositories = await listGitHubWorkInstallationRepositories({ installationId });

    await syncGitHubIntegrationRepositories({
      workspaceId: current.workspace.id,
      installationId,
      accountLogin: installation.account?.login ?? verifiedInstallation.account?.login ?? null,
      accountType: installation.account?.type ?? verifiedInstallation.account?.type ?? null,
      connectedByUserId: current.user.id,
      repositories,
      userOAuthToken: userToken,
    });

    return NextResponse.redirect(
      new URL(appendIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch (error) {
    captureException(error, {
      event: "opencompany.github_integration_callback_failed",
      reason: "connection_sync_failed",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      intent: state.intent,
      installation_id: installationId,
    });
    logger.error("GitHub integration callback failed while connecting installation", {
      event: "opencompany.github_integration_callback_failed",
      reason: "connection_sync_failed",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      intent: state.intent,
      installation_id: installationId,
      error_message: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }
}
