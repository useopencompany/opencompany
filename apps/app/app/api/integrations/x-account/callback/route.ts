import { captureIntegrationAddedAnalytics } from "@opencompany/core/integrations/analytics";
import { connectXAccountIntegration } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendXAccountIntegrationStatus,
  exchangeXAccountCode,
  fetchXAccountIdentity,
  isXAccountIntegrationConfigured,
  verifyXAccountIntegrationState,
} from "@/lib/integrations/x-account";
import { consumeXAccountPkceCookie } from "@/lib/integrations/x-account-pkce";

export async function GET(request: Request) {
  const current = await currentUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";
  const codeVerifier = await consumeXAccountPkceCookie();

  let state;
  try {
    state = verifyXAccountIntegrationState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=x_account&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendXAccountIntegrationStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (!isXAccountIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendXAccountIntegrationStatus(state.returnTo, "error", "not_configured"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendXAccountIntegrationStatus(state.returnTo, "error", "x_account_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code || !codeVerifier) {
    return NextResponse.redirect(
      new URL(appendXAccountIntegrationStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const oauth = await exchangeXAccountCode(code, codeVerifier);
    const identity = await fetchXAccountIdentity(oauth.accessToken);

    await connectXAccountIntegration({
      userWorkosId: current.user.workosUserId,
      xUserId: identity.id,
      username: identity.username,
      name: identity.name,
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
    });
    await captureIntegrationAddedAnalytics({
      userWorkosId: current.user.workosUserId,
      workspaceId: current.workspace.id,
      provider: "x_account",
    });

    return NextResponse.redirect(
      new URL(appendXAccountIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(
        appendXAccountIntegrationStatus(state.returnTo, "error", "connection_sync_failed"),
        url,
      ),
    );
  }
}
