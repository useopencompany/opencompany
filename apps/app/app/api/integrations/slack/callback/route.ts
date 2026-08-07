import { connectGoatSlackIntegration } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { captureGoatIntegrationAddedAnalytics } from "@/lib/integrations/analytics";
import {
  appendGoatSlackIntegrationStatus,
  exchangeGoatSlackCode,
  fetchGoatSlackIdentity,
  isGoatSlackIntegrationConfigured,
  verifyGoatSlackIntegrationState,
} from "@/lib/integrations/slack";

export async function GET(request: Request) {
  const current = await currentGoatUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyGoatSlackIntegrationState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=slack&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendGoatSlackIntegrationStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (!isGoatSlackIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatSlackIntegrationStatus(state.returnTo, "error", "not_configured"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendGoatSlackIntegrationStatus(state.returnTo, "error", "slack_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendGoatSlackIntegrationStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const oauth = await exchangeGoatSlackCode(code);
    const identity = await fetchGoatSlackIdentity({
      accessToken: oauth.accessToken,
      authedUserId: oauth.authedUserId,
    });

    await connectGoatSlackIntegration({
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
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId: current.user.workosUserId,
      workspaceId: current.workspace.id,
      provider: "slack",
    });

    return NextResponse.redirect(
      new URL(appendGoatSlackIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(
        appendGoatSlackIntegrationStatus(state.returnTo, "error", "connection_sync_failed"),
        url,
      ),
    );
  }
}
