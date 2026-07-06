import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatGitHubIntegrationStatus,
  buildGoatGitHubUserAuthorizationUrl,
  createGoatGitHubIntegrationState,
  exchangeGoatGitHubUserCode,
  getGoatGitHubInstallation,
  isGoatGitHubIntegrationConfigured,
  listGoatGitHubInstallationRepositories,
  syncGoatGitHubIntegrationRepositories,
  verifyGoatGitHubIntegrationState,
  verifyGoatGitHubUserInstallation,
} from "@/lib/integrations/github";

export async function GET(request: Request) {
  const current = await currentGoatUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyGoatGitHubIntegrationState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=github&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendGoatGitHubIntegrationStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (!isGoatGitHubIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatGitHubIntegrationStatus(state.returnTo, "error", "not_configured"), url),
    );
  }

  const installationId = state.installationId ?? url.searchParams.get("installation_id");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendGoatGitHubIntegrationStatus(state.returnTo, "error", "github_denied"), url),
    );
  }

  if (!installationId) {
    return NextResponse.redirect(
      new URL(
        appendGoatGitHubIntegrationStatus(state.returnTo, "error", "missing_installation_id"),
        url,
      ),
    );
  }

  if (!code) {
    const nextState = createGoatGitHubIntegrationState({
      userWorkosId: state.userWorkosId,
      returnTo: state.returnTo,
      installationId,
    });
    return NextResponse.redirect(buildGoatGitHubUserAuthorizationUrl(nextState));
  }

  try {
    const userToken = await exchangeGoatGitHubUserCode(code);
    const verifiedInstallation = await verifyGoatGitHubUserInstallation({
      userToken,
      installationId,
    });
    const installation = await getGoatGitHubInstallation({ installationId });
    const repositories = await listGoatGitHubInstallationRepositories({ installationId });

    await syncGoatGitHubIntegrationRepositories({
      userWorkosId: current.user.workosUserId,
      installationId,
      accountLogin: installation.account?.login ?? verifiedInstallation.account?.login ?? null,
      accountType: installation.account?.type ?? verifiedInstallation.account?.type ?? null,
      repositories,
    });

    return NextResponse.redirect(
      new URL(appendGoatGitHubIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(
        appendGoatGitHubIntegrationStatus(state.returnTo, "error", "connection_sync_failed"),
        url,
      ),
    );
  }
}
