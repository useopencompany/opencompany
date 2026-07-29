import { connectGoatGoogleIntegration } from "@opencompany/db/goat-integrations";
import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { captureGoatIntegrationAddedAnalytics } from "@/lib/integrations/analytics";
import {
  appendGoatGoogleIntegrationStatus,
  buildGoatGoogleAuthorizationUrl,
  createGoatGoogleIntegrationState,
  exchangeGoatGoogleCode,
  fetchGoatGoogleUserInfo,
  GOAT_GOOGLE_PROVIDER_CONFIG,
  type GoatGoogleIntegrationProvider,
  goatGoogleOAuthRedirectUri,
  goatGoogleOAuthTargetOriginForState,
  isGoatGoogleIntegrationConfigured,
  verifyGoatGoogleIntegrationState,
} from "@/lib/integrations/google-oauth";

export async function handleGoatGoogleOAuthStart(
  provider: GoatGoogleIntegrationProvider,
  request: Request,
) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";
  const config = GOAT_GOOGLE_PROVIDER_CONFIG[provider];
  const oauthRedirectUri = goatGoogleOAuthRedirectUri(config);
  const targetOrigin = goatGoogleOAuthTargetOriginForState();

  if (!isGoatGoogleIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatGoogleIntegrationStatus(returnTo, provider, "error"), url),
    );
  }

  const state = createGoatGoogleIntegrationState({
    provider,
    userWorkosId: user.workosUserId,
    returnTo,
    oauthRedirectUri,
    ...(targetOrigin ? { targetOrigin } : {}),
  });

  return NextResponse.redirect(buildGoatGoogleAuthorizationUrl(config, state, oauthRedirectUri));
}

export async function handleGoatGoogleOAuthCallback(
  provider: GoatGoogleIntegrationProvider,
  request: Request,
) {
  const current = await currentGoatUser();
  const url = new URL(request.url);
  const config = GOAT_GOOGLE_PROVIDER_CONFIG[provider];
  const errorRedirect = (returnTo: string) =>
    NextResponse.redirect(
      new URL(appendGoatGoogleIntegrationStatus(returnTo, provider, "error"), url),
    );

  let state;
  try {
    state = verifyGoatGoogleIntegrationState(url.searchParams.get("state") ?? "");
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

  if (!isGoatGoogleIntegrationConfigured()) {
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
    const { tokens, expiresAt } = await exchangeGoatGoogleCode(
      config,
      code,
      state.oauthRedirectUri,
    );
    const userInfo = await fetchGoatGoogleUserInfo(tokens.access_token);
    await connectGoatGoogleIntegration({
      provider,
      userWorkosId: current.user.workosUserId,
      externalId: userInfo.sub,
      accountEmail: userInfo.email ?? null,
      accountName: userInfo.name ?? null,
      tokens,
      expiresAt,
      scopes: readScopes(tokens.scope, config.scopes),
    });
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId: current.user.workosUserId,
      workspaceId: current.workspace.id,
      provider,
    });

    return NextResponse.redirect(
      new URL(appendGoatGoogleIntegrationStatus(state.returnTo, provider, "connected"), url),
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
