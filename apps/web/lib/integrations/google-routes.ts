import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import {
  appendGoogleIntegrationStatus,
  buildGoogleAuthorizationUrl,
  createGoogleIntegrationState,
  exchangeGoogleCode,
  fetchGoogleCalendarList,
  fetchGoogleUserInfo,
  GOOGLE_PROVIDER_CONFIG,
  type GoogleIntegrationProvider,
  isGoogleIntegrationConfigured,
  verifyGoogleIntegrationState,
} from "@/lib/integrations/google-oauth";
import { connectGoogleIntegration } from "@/lib/integrations/google-service";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// Both Gmail and Google Calendar route pairs are thin wrappers over these handlers; they pass
// their own provider so the shared logic stays in one place.

export async function handleGoogleOAuthStart(
  provider: GoogleIntegrationProvider,
  request: Request,
) {
  // Per-user connection: any workspace member can attach their own Google account.
  const { user, workspace } = await currentWorkspace();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings/integrations";

  if (!isGoogleIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoogleIntegrationStatus(returnTo, provider, "error"), url),
    );
  }

  const state = createGoogleIntegrationState({
    provider,
    workspaceId: workspace.id,
    userId: user.id,
    returnTo,
  });

  return NextResponse.redirect(
    buildGoogleAuthorizationUrl(GOOGLE_PROVIDER_CONFIG[provider], state),
  );
}

export async function handleGoogleOAuthCallback(
  provider: GoogleIntegrationProvider,
  request: Request,
) {
  const current = await currentWorkspace();
  const url = new URL(request.url);
  const config = GOOGLE_PROVIDER_CONFIG[provider];
  const errorRedirect = (returnTo: string) =>
    NextResponse.redirect(new URL(appendGoogleIntegrationStatus(returnTo, provider, "error"), url));

  let state;
  try {
    state = verifyGoogleIntegrationState(url.searchParams.get("state") ?? "");
  } catch (error) {
    captureException(error, {
      event: "opencompany.google_integration_callback_failed",
      reason: "invalid_state",
      provider,
    });
    return errorRedirect("/settings/integrations");
  }

  if (
    state.provider !== provider ||
    state.workspaceId !== current.workspace.id ||
    state.userId !== current.user.id
  ) {
    logger.warn("Google integration callback state did not match current session", {
      event: "opencompany.google_integration_callback_failed",
      reason: "state_session_mismatch",
      provider,
    });
    return errorRedirect(state.returnTo);
  }

  if (!isGoogleIntegrationConfigured()) {
    logger.error("Google integration callback reached without required configuration", {
      event: "opencompany.google_integration_callback_failed",
      reason: "not_configured",
      provider,
    });
    return errorRedirect(state.returnTo);
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logger.warn("Google integration OAuth returned an error", {
      event: "opencompany.google_integration_callback_failed",
      reason: "oauth_error",
      provider,
      oauth_error: oauthError,
    });
    return errorRedirect(state.returnTo);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    logger.warn("Google integration callback missing authorization code", {
      event: "opencompany.google_integration_callback_failed",
      reason: "missing_code",
      provider,
    });
    return errorRedirect(state.returnTo);
  }

  try {
    const { tokens, expiresAt } = await exchangeGoogleCode(config, code);
    const userInfo = await fetchGoogleUserInfo(tokens.access_token);
    const calendars = config.syncsCalendars
      ? await fetchGoogleCalendarList(tokens.access_token)
      : undefined;

    await connectGoogleIntegration({
      provider,
      workspaceId: current.workspace.id,
      connectedByUserId: current.user.id,
      externalId: userInfo.sub,
      accountEmail: userInfo.email ?? null,
      accountName: userInfo.name ?? null,
      tokens,
      expiresAt,
      ...(calendars ? { calendars } : {}),
    });

    return NextResponse.redirect(
      new URL(appendGoogleIntegrationStatus(state.returnTo, provider, "connected"), url),
    );
  } catch (error) {
    captureException(error, {
      event: "opencompany.google_integration_callback_failed",
      reason: "connection_sync_failed",
      provider,
      workspace_id: current.workspace.id,
      user_id: current.user.id,
    });
    logger.error("Google integration callback failed while connecting account", {
      event: "opencompany.google_integration_callback_failed",
      reason: "connection_sync_failed",
      provider,
      error_message: error instanceof Error ? error.message : "Unknown error",
    });
    return errorRedirect(state.returnTo);
  }
}
