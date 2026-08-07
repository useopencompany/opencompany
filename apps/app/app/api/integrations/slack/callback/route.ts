import { captureIntegrationAddedAnalytics } from "@opencompany/core/integrations/analytics";
import {
  appendSlackIntegrationStatus,
  exchangeSlackCode,
  fetchSlackIdentity,
  isSlackIntegrationConfigured,
  verifySlackIntegrationState,
} from "@opencompany/core/integrations/slack";
import { connectSlackIntegration } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export async function GET(request: Request) {
  const current = await currentUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifySlackIntegrationState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=slack&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendSlackIntegrationStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (!isSlackIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendSlackIntegrationStatus(state.returnTo, "error", "not_configured"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendSlackIntegrationStatus(state.returnTo, "error", "slack_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendSlackIntegrationStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const oauth = await exchangeSlackCode(code);
    const identity = await fetchSlackIdentity({
      accessToken: oauth.accessToken,
      authedUserId: oauth.authedUserId,
    });

    await connectSlackIntegration({
      userWorkosId: current.user.workosUserId,
      teamId: oauth.teamId,
      teamName: oauth.teamName,
      teamDomain: identity.teamDomain,
      authedUserId: oauth.authedUserId,
      accountName: identity.userName,
      accountEmail: identity.userEmail,
      accessToken: oauth.accessToken,
      scopes: oauth.scopes,
    });
    await captureIntegrationAddedAnalytics({
      userWorkosId: current.user.workosUserId,
      workspaceId: current.workspace.id,
      provider: "slack",
    });

    return NextResponse.redirect(
      new URL(appendSlackIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(appendSlackIntegrationStatus(state.returnTo, "error", "connection_sync_failed"), url),
    );
  }
}
