import { captureIntegrationAddedAnalytics } from "@opencompany/core/integrations/analytics";
import {
  appendGitHubIntegrationStatus,
  buildGitHubUserAuthorizationUrl,
  createGitHubIntegrationState,
  exchangeGitHubUserCode,
  getGitHubInstallation,
  isGitHubIntegrationConfigured,
  listGitHubInstallationRepositories,
  syncGitHubIntegrationRepositories,
  verifyGitHubIntegrationState,
  verifyGitHubUserInstallation,
} from "@opencompany/core/integrations/github";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export async function GET(request: Request) {
  const current = await currentUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyGitHubIntegrationState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=github&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendGitHubIntegrationStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  // The installation lands on the workspace the flow started in; the finishing
  // session must still be an admin of that workspace.
  const membership = current.workspaces.find((entry) => entry.workspace.id === state.workspaceId);
  if (!membership || membership.role !== "admin") {
    return NextResponse.redirect(
      new URL(appendGitHubIntegrationStatus(state.returnTo, "error", "admin_required"), url),
    );
  }

  if (!isGitHubIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGitHubIntegrationStatus(state.returnTo, "error", "not_configured"), url),
    );
  }

  const installationId = state.installationId ?? url.searchParams.get("installation_id");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendGitHubIntegrationStatus(state.returnTo, "error", "github_denied"), url),
    );
  }

  if (!installationId) {
    return NextResponse.redirect(
      new URL(
        appendGitHubIntegrationStatus(state.returnTo, "error", "missing_installation_id"),
        url,
      ),
    );
  }

  if (!code) {
    const nextState = createGitHubIntegrationState({
      userWorkosId: state.userWorkosId,
      workspaceId: state.workspaceId,
      returnTo: state.returnTo,
      installationId,
    });
    return NextResponse.redirect(buildGitHubUserAuthorizationUrl(nextState));
  }

  try {
    const userToken = await exchangeGitHubUserCode(code);
    const verifiedInstallation = await verifyGitHubUserInstallation({
      userToken,
      installationId,
    });
    const installation = await getGitHubInstallation({ installationId });
    const repositories = await listGitHubInstallationRepositories({ installationId });

    await syncGitHubIntegrationRepositories({
      userWorkosId: current.user.workosUserId,
      workspaceId: state.workspaceId,
      installationId,
      accountLogin: installation.account?.login ?? verifiedInstallation.account?.login ?? null,
      accountType: installation.account?.type ?? verifiedInstallation.account?.type ?? null,
      repositories,
    });
    await captureIntegrationAddedAnalytics({
      userWorkosId: current.user.workosUserId,
      workspaceId: state.workspaceId,
      provider: "github",
    });

    return NextResponse.redirect(
      new URL(appendGitHubIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(
        appendGitHubIntegrationStatus(state.returnTo, "error", "connection_sync_failed"),
        url,
      ),
    );
  }
}
