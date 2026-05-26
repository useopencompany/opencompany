import { NextResponse } from "next/server";
import { getCurrentWorkspace } from "@/lib/auth";
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

export async function GET(request: Request) {
  const current = await getCurrentWorkspace();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyGitHubIntegrationState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings/integrations?integration=github&setup=error", url),
    );
  }

  if (state.workspaceId !== current.workspace.id || state.userId !== current.user.id) {
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }

  if (!isGitHubWorkIntegrationConfigured()) {
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }

  const installationId = state.installationId ?? url.searchParams.get("installation_id");
  const code = url.searchParams.get("code");
  if (!installationId) {
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }

  if (!code) {
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
    const userToken = await exchangeGitHubUserCode(code);
    const verifiedInstallation = await verifyGitHubUserInstallation({ userToken, installationId });
    const installation = await getGitHubWorkInstallation({ installationId });
    const repositories = await listGitHubWorkInstallationRepositories({ installationId });

    await syncGitHubIntegrationRepositories({
      workspaceId: current.workspace.id,
      installationId,
      accountLogin: installation.account?.login ?? verifiedInstallation.account?.login ?? null,
      accountType: installation.account?.type ?? verifiedInstallation.account?.type ?? null,
      repositories,
    });

    return NextResponse.redirect(
      new URL(appendIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(new URL(appendIntegrationStatus(state.returnTo, "error"), url));
  }
}
