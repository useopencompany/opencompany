import { connectGoatXIntegration } from "@opencompany/db/goat-integrations";
import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { captureGoatIntegrationAddedAnalytics } from "@/lib/integrations/analytics";
import {
  appendGoatXIntegrationStatus,
  exchangeGoatXCode,
  fetchGoatXIdentity,
  isGoatXIntegrationConfigured,
  verifyGoatXIntegrationState,
} from "@/lib/integrations/x";

const X_OAUTH_COOKIE_PATH = "/api/integrations/x";

export async function GET(request: Request) {
  const current = await currentGoatUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyGoatXIntegrationState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=x&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return redirectAndClearVerifier(
      new URL(appendGoatXIntegrationStatus(state.returnTo, "error", "session_mismatch"), url),
      xOAuthVerifierCookieName(state.nonce),
    );
  }

  if (!isGoatXIntegrationConfigured()) {
    return redirectAndClearVerifier(
      new URL(appendGoatXIntegrationStatus(state.returnTo, "error", "not_configured"), url),
      xOAuthVerifierCookieName(state.nonce),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return redirectAndClearVerifier(
      new URL(appendGoatXIntegrationStatus(state.returnTo, "error", "x_denied"), url),
      xOAuthVerifierCookieName(state.nonce),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return redirectAndClearVerifier(
      new URL(appendGoatXIntegrationStatus(state.returnTo, "error", "missing_code"), url),
      xOAuthVerifierCookieName(state.nonce),
    );
  }

  const verifierCookieName = xOAuthVerifierCookieName(state.nonce);
  const codeVerifier = cookieValue(request.headers.get("cookie"), verifierCookieName);
  if (!codeVerifier) {
    return redirectAndClearVerifier(
      new URL(appendGoatXIntegrationStatus(state.returnTo, "error", "invalid_state"), url),
      verifierCookieName,
    );
  }

  try {
    const oauth = await exchangeGoatXCode({ code, codeVerifier });
    const identity = await fetchGoatXIdentity(oauth.accessToken);

    await connectGoatXIntegration({
      userWorkosId: current.user.workosUserId,
      xUserId: identity.id,
      username: identity.username,
      displayName: identity.name,
      accessToken: oauth.accessToken,
      ...(oauth.refreshToken ? { refreshToken: oauth.refreshToken } : {}),
      ...(oauth.tokenType ? { tokenType: oauth.tokenType } : {}),
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
    });
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId: current.user.workosUserId,
      workspaceId: current.workspace.id,
      provider: "x",
    });

    return redirectAndClearVerifier(
      new URL(appendGoatXIntegrationStatus(state.returnTo, "connected"), url),
      verifierCookieName,
    );
  } catch {
    return redirectAndClearVerifier(
      new URL(appendGoatXIntegrationStatus(state.returnTo, "error", "connection_sync_failed"), url),
      verifierCookieName,
    );
  }
}

function xOAuthVerifierCookieName(nonce: string) {
  return `goat_x_oauth_verifier_${nonce}`;
}

function cookieValue(header: string | null, name: string) {
  if (!header) return null;
  const prefix = `${name}=`;
  const match = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!match) return null;
  return decodeURIComponent(match.slice(prefix.length));
}

function redirectAndClearVerifier(url: URL, cookieName: string) {
  const response = NextResponse.redirect(url);
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: X_OAUTH_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}
