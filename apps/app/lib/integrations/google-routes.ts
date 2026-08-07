import { connectGoogleIntegration } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { captureIntegrationAddedAnalytics } from "@/lib/integrations/analytics";
import {
  appendGoogleIntegrationStatus,
  buildGoogleAuthorizationUrl,
  createGoogleIntegrationState,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  GOAT_GOOGLE_PROVIDER_CONFIG,
  type GoogleIntegrationProvider,
  googleOAuthRedirectUri,
  googleOAuthTargetOriginForState,
  isGoogleIntegrationConfigured,
  verifyGoogleIntegrationState,
} from "@/lib/integrations/google-oauth";

export async function handleGoogleOAuthStart(
  provider: GoogleIntegrationProvider,
  request: Request,
) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";
  const config = GOAT_GOOGLE_PROVIDER_CONFIG[provider];
  const oauthRedirectUri = googleOAuthRedirectUri(config);
  const targetOrigin = googleOAuthTargetOriginForState();

  if (!isGoogleIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoogleIntegrationStatus(returnTo, provider, "error"), url),
    );
  }

  const state = createGoogleIntegrationState({
    provider,
    userWorkosId: user.workosUserId,
    returnTo,
    oauthRedirectUri,
    ...(targetOrigin ? { targetOrigin } : {}),
  });

  return NextResponse.redirect(buildGoogleAuthorizationUrl(config, state, oauthRedirectUri));
}

export async function handleGoogleOAuthCallback(
  provider: GoogleIntegrationProvider,
  request: Request,
) {
  const current = await currentUser();
  const url = new URL(request.url);
  const config = GOAT_GOOGLE_PROVIDER_CONFIG[provider];
  const errorRedirect = (returnTo: string) =>
    NextResponse.redirect(new URL(appendGoogleIntegrationStatus(returnTo, provider, "error"), url));

  let state;
  try {
    state = verifyGoogleIntegrationState(url.searchParams.get("state") ?? "");
  } catch (error) {
    console.warn("Goat Google integration callback failed with invalid state.", {
      event: "goat.google_integration_callback_failed",
      reason: "invalid_state",
      provider,
      error,
    });
    return errorRedirect("/settings");
  }

  if (state.provider !== provider || state.userWorkosId !== current.user.workosUserId) {
    console.warn("Goat Google integration callback state did not match current session.", {
      event: "goat.google_integration_callback_failed",
      reason: "state_session_mismatch",
      provider,
    });
    return errorRedirect(state.returnTo);
  }

  if (!isGoogleIntegrationConfigured()) {
    return errorRedirect(state.returnTo);
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    console.warn("Goat Google integration OAuth returned an error.", {
      event: "goat.google_integration_callback_failed",
      reason: "oauth_error",
      provider,
      oauth_error: oauthError,
    });
    return errorRedirect(state.returnTo);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return errorRedirect(state.returnTo);
  }

  try {
    const { tokens, expiresAt } = await exchangeGoogleCode(config, code, state.oauthRedirectUri);
    const userInfo = await fetchGoogleUserInfo(tokens.access_token);
    await connectGoogleIntegration({
      provider,
      userWorkosId: current.user.workosUserId,
      externalId: userInfo.sub,
      accountEmail: userInfo.email ?? null,
      accountName: userInfo.name ?? null,
      tokens,
      expiresAt,
      scopes: readScopes(tokens.scope, config.scopes),
    });
    await captureIntegrationAddedAnalytics({
      userWorkosId: current.user.workosUserId,
      workspaceId: current.workspace.id,
      provider,
    });

    return NextResponse.redirect(
      new URL(appendGoogleIntegrationStatus(state.returnTo, provider, "connected"), url),
    );
  } catch (error) {
    console.warn("Goat Google integration callback failed while connecting account.", {
      event: "goat.google_integration_callback_failed",
      reason: "connection_sync_failed",
      provider,
      error,
    });
    return errorRedirect(state.returnTo);
  }
}

function readScopes(scope: string | undefined, fallback: string[]) {
  if (!scope) return fallback;
  const scopes = scope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : fallback;
}
