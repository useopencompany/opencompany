import { createHash, timingSafeEqual } from "node:crypto";
import { getAppUrl } from "@opencompany/agent/app-url";
import { captureIntegrationAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import {
  appendGoogleIntegrationStatus,
  buildGoogleAuthorizationUrl,
  createGoogleIntegrationState,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  type GoogleIntegrationProvider,
  googleAuthorizationConfigForReturnTo,
  googleOAuthRedirectUri,
  googleProviderConfigForAccess,
  isGoogleIntegrationConfigured,
  verifyGoogleIntegrationState,
} from "@opencompany/agent/integrations/google-oauth";
import {
  loadGoogleDriveWatchChannel,
  requestGoogleDriveCursorWake,
} from "@opencompany/db/google-drive";
import { connectGoogleIntegration } from "@opencompany/db/integrations";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "google-ingress" });

type DbLike = any;

// Provider ingress composition for the Google family (Gmail, Calendar,
// Drive): the shared OAuth connect flow plus the Drive push-notification
// webhook. Public URLs stay on the web origin — web relays the exact request
// here — so no Google Cloud console or Drive watch configuration changes.
export type GoogleIngressService = {
  start(provider: GoogleIntegrationProvider, request: Request): Promise<Response>;
  callback(provider: GoogleIntegrationProvider, request: Request): Promise<Response>;
  driveWebhook(request: Request): Promise<Response>;
};

export function createGoogleIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: (input: {
    provider: GoogleIntegrationProvider;
    userWorkosId: string;
    workspaceIds: string[];
  }) => Promise<void>;
}): GoogleIngressService {
  return {
    start: (provider, request) => handleStart(input, provider, request),
    callback: (provider, request) => handleCallback(input, provider, request),
    driveWebhook: (request) => handleDriveWebhook(input, request),
  };
}

type IngressInput = {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: (input: {
    provider: GoogleIntegrationProvider;
    userWorkosId: string;
    workspaceIds: string[];
  }) => Promise<void>;
};

async function handleStart(
  input: IngressInput,
  provider: GoogleIntegrationProvider,
  request: Request,
): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";
  const access =
    provider === "gmail" && url.searchParams.get("access") === "mcp" ? "gmail_mcp" : "default";
  const config = googleProviderConfigForAccess(provider, access);
  const authorizationConfig = googleAuthorizationConfigForReturnTo(config, returnTo);
  const oauthRedirectUri = googleOAuthRedirectUri(config);

  if (!isGoogleIntegrationConfigured()) {
    return statusRedirect(session, returnTo, provider, "error");
  }

  const state = createGoogleIntegrationState({
    provider,
    access,
    userWorkosId: session.userId,
    returnTo,
  });
  return sessionRedirect(
    session,
    buildGoogleAuthorizationUrl(authorizationConfig, state, oauthRedirectUri),
  );
}

async function handleCallback(
  input: IngressInput,
  provider: GoogleIntegrationProvider,
  request: Request,
): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const errorRedirect = (returnTo: string) => statusRedirect(session, returnTo, provider, "error");

  let state: ReturnType<typeof verifyGoogleIntegrationState>;
  try {
    state = verifyGoogleIntegrationState(url.searchParams.get("state") ?? "");
  } catch (error) {
    logger.warn("Google integration callback failed with invalid state", {
      event: "goat.google_integration_callback_failed",
      reason: "invalid_state",
      provider,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return errorRedirect("/settings");
  }

  if (state.provider !== provider || state.userWorkosId !== session.userId) {
    logger.warn("Google integration callback state did not match current session", {
      event: "goat.google_integration_callback_failed",
      reason: "state_session_mismatch",
      provider,
    });
    return errorRedirect(state.returnTo);
  }
  const config = googleProviderConfigForAccess(provider, state.access);

  if (!isGoogleIntegrationConfigured()) {
    return errorRedirect(state.returnTo);
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logger.warn("Google integration OAuth returned an error", {
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
    const authorizationConfig = googleAuthorizationConfigForReturnTo(config, state.returnTo);
    const { tokens, expiresAt } = await exchangeGoogleCode(
      config,
      code,
      googleOAuthRedirectUri(config),
    );
    const userInfo = await fetchGoogleUserInfo(tokens.access_token);
    await connectGoogleIntegration({
      provider,
      userWorkosId: session.userId,
      externalId: userInfo.sub,
      accountEmail: userInfo.email ?? null,
      accountName: userInfo.name ?? null,
      tokens,
      expiresAt,
      scopes: readScopes(tokens.scope, authorizationConfig.scopes),
      db: input.db,
    });
    await captureIntegrationAddedAnalytics({
      userWorkosId: session.userId,
      workspaceId: session.workspaceId,
      provider,
    });
    if (provider !== "gmail" || state.access === "gmail_mcp") {
      await refreshGooglePluginAfterConnection(input, session, provider);
    }

    return statusRedirect(session, state.returnTo, provider, "connected");
  } catch (error) {
    logger.warn("Google integration callback failed while connecting account", {
      event: "goat.google_integration_callback_failed",
      reason: "connection_sync_failed",
      provider,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return errorRedirect(state.returnTo);
  }
}

async function refreshGooglePluginAfterConnection(
  input: IngressInput,
  session: Extract<Awaited<ReturnType<typeof resolveIngressSession>>, { kind: "actor" }>,
  provider: GoogleIntegrationProvider,
) {
  if (!input.refreshPluginRegistrations) return;
  try {
    await input.refreshPluginRegistrations({
      provider,
      userWorkosId: session.userId,
      workspaceIds: session.workspaces.map((entry) => entry.workspace.id),
    });
  } catch (error) {
    logger.warn("Google plugin discovery refresh after connection failed", {
      event:
        provider === "google_drive"
          ? "goat.google_drive_plugin_reconnect_refresh_failed"
          : provider === "gmail"
            ? "goat.gmail_plugin_reconnect_refresh_failed"
            : "goat.google_calendar_plugin_reconnect_refresh_failed",
      provider,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleDriveWebhook(input: IngressInput, request: Request): Promise<Response> {
  const channelId = request.headers.get("x-goog-channel-id")?.trim();
  const channelToken = request.headers.get("x-goog-channel-token")?.trim();
  const resourceId = request.headers.get("x-goog-resource-id")?.trim();
  const resourceState = request.headers.get("x-goog-resource-state")?.trim();
  if (!channelId || !channelToken || !resourceId || !resourceState) {
    return new Response("Missing Google Drive notification headers.", { status: 400 });
  }
  const channel = await loadGoogleDriveWatchChannel(channelId, input.db);
  if (
    !channel ||
    channel.status === "stopped" ||
    (channel.expiresAt && channel.expiresAt.getTime() <= Date.now()) ||
    !safeEqual(channel.tokenHash, sha256(channelToken)) ||
    (channel.resourceId && !safeEqual(channel.resourceId, resourceId))
  ) {
    return new Response("Invalid Google Drive notification channel.", { status: 401 });
  }

  // Google can deliver the initial sync before the watch response reaches the
  // runner. The creating row already holds the channel id/token, so accepting
  // it here is safe even while resource_id is not populated yet. The durable
  // cursor wake propagates to the runner through the admission triggers.
  if (resourceState === "sync" || resourceState === "change") {
    await requestGoogleDriveCursorWake(channel.cursorId, new Date(), input.db);
  }
  return new Response(null, { status: 204 });
}

function statusRedirect(
  session: Extract<Awaited<ReturnType<typeof resolveIngressSession>>, { kind: "actor" }>,
  returnTo: string,
  provider: GoogleIntegrationProvider,
  status: "connected" | "error",
) {
  return sessionRedirect(
    session,
    new URL(appendGoogleIntegrationStatus(returnTo, provider, status), getAppUrl()),
  );
}

function readScopes(scope: string | undefined, fallback: string[]) {
  if (!scope) return fallback;
  const scopes = scope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : fallback;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
