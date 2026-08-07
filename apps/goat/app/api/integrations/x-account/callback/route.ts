import { connectGoatXAccountIntegration } from "@opencompany/db/goat-integrations";
import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { captureGoatIntegrationAddedAnalytics } from "@/lib/integrations/analytics";
import {
  appendGoatXAccountIntegrationStatus,
  exchangeGoatXAccountCode,
  fetchGoatXAccountIdentity,
  isGoatXAccountIntegrationConfigured,
  verifyGoatXAccountIntegrationState,
} from "@/lib/integrations/x-account";
import { consumeGoatXAccountPkceCookie } from "@/lib/integrations/x-account-pkce";

export async function GET(request: Request) {
  const current = await currentGoatUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";
  const codeVerifier = await consumeGoatXAccountPkceCookie();

  let state;
  try {
    state = verifyGoatXAccountIntegrationState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=x_account&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(
        appendGoatXAccountIntegrationStatus(state.returnTo, "error", "session_mismatch"),
        url,
      ),
    );
  }

  if (!isGoatXAccountIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatXAccountIntegrationStatus(state.returnTo, "error", "not_configured"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(
        appendGoatXAccountIntegrationStatus(state.returnTo, "error", "x_account_denied"),
        url,
      ),
    );
  }

  const code = url.searchParams.get("code");
  if (!code || !codeVerifier) {
    return NextResponse.redirect(
      new URL(appendGoatXAccountIntegrationStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const oauth = await exchangeGoatXAccountCode(code, codeVerifier);
    const identity = await fetchGoatXAccountIdentity(oauth.accessToken);

    await connectGoatXAccountIntegration({
      userWorkosId: current.user.workosUserId,
      xUserId: identity.id,
      username: identity.username,
      name: identity.name,
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
    });
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId: current.user.workosUserId,
      workspaceId: current.workspace.id,
      provider: "x_account",
    });

    return NextResponse.redirect(
      new URL(appendGoatXAccountIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(
        appendGoatXAccountIntegrationStatus(state.returnTo, "error", "connection_sync_failed"),
        url,
      ),
    );
  }
}
