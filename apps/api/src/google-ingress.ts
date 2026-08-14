import { createHash, timingSafeEqual } from "node:crypto";
import {
  loadGoatGoogleDriveWatchChannel,
  requestGoatGoogleDriveCursorWake,
} from "@opencompany/db/goat-google-drive";
import { connectGoatGoogleIntegration } from "@opencompany/db/goat-integrations";
import { getGoatAppUrl } from "@opencompany/goat-agent/app-url";
import { captureGoatIntegrationAddedAnalytics } from "@opencompany/goat-agent/integrations/analytics";
import {
  appendGoatGoogleIntegrationStatus,
  buildGoatGoogleAuthorizationUrl,
  createGoatGoogleIntegrationState,
  exchangeGoatGoogleCode,
  fetchGoatGoogleUserInfo,
  GOAT_GOOGLE_PROVIDER_CONFIG,
  type GoatGoogleIntegrationProvider,
  goatGoogleOAuthRedirectUri,
  isGoatGoogleIntegrationConfigured,
  verifyGoatGoogleIntegrationState,
} from "@opencompany/goat-agent/integrations/google-oauth";
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
  start(provider: GoatGoogleIntegrationProvider, request: Request): Promise<Response>;
  callback(provider: GoatGoogleIntegrationProvider, request: Request): Promise<Response>;
  driveWebhook(request: Request): Promise<Response>;
};

export function createGoogleIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
}): GoogleIngressService {
  return {
    start: (provider, request) => handleStart(input, provider, request),
    callback: (provider, request) => handleCallback(input, provider, request),
    driveWebhook: (request) => handleDriveWebhook(input, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier };

async function handleStart(
  input: IngressInput,
  provider: GoatGoogleIntegrationProvider,
  request: Request,
): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";
  const config = GOAT_GOOGLE_PROVIDER_CONFIG[provider];
  const oauthRedirectUri = goatGoogleOAuthRedirectUri(config);

  if (!isGoatGoogleIntegrationConfigured()) {
    return statusRedirect(session, returnTo, provider, "error");
  }

  const state = createGoatGoogleIntegrationState({
    provider,
    userWorkosId: session.userId,
    returnTo,
  });
  return sessionRedirect(session, buildGoatGoogleAuthorizationUrl(config, state, oauthRedirectUri));
}

async function handleCallback(
  input: IngressInput,
  provider: GoatGoogleIntegrationProvider,
  request: Request,
): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const config = GOAT_GOOGLE_PROVIDER_CONFIG[provider];
  const errorRedirect = (returnTo: string) => statusRedirect(session, returnTo, provider, "error");

  let state: ReturnType<typeof verifyGoatGoogleIntegrationState>;
  try {
    state = verifyGoatGoogleIntegrationState(url.searchParams.get("state") ?? "");
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

  if (!isGoatGoogleIntegrationConfigured()) {
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
    const { tokens, expiresAt } = await exchangeGoatGoogleCode(
      config,
      code,
      goatGoogleOAuthRedirectUri(config),
    );
    const userInfo = await fetchGoatGoogleUserInfo(tokens.access_token);
    await connectGoatGoogleIntegration({
      provider,
      userWorkosId: session.userId,
      externalId: userInfo.sub,
      accountEmail: userInfo.email ?? null,
      accountName: userInfo.name ?? null,
      tokens,
      expiresAt,
      scopes: readScopes(tokens.scope, config.scopes),
      db: input.db,
    });
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId: session.userId,
      workspaceId: session.workspaceId,
      provider,
    });

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

async function handleDriveWebhook(input: IngressInput, request: Request): Promise<Response> {
  const channelId = request.headers.get("x-goog-channel-id")?.trim();
  const channelToken = request.headers.get("x-goog-channel-token")?.trim();
  const resourceId = request.headers.get("x-goog-resource-id")?.trim();
  const resourceState = request.headers.get("x-goog-resource-state")?.trim();
  if (!channelId || !channelToken || !resourceId || !resourceState) {
    return new Response("Missing Google Drive notification headers.", { status: 400 });
  }
  const channel = await loadGoatGoogleDriveWatchChannel(channelId, input.db);
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
    await requestGoatGoogleDriveCursorWake(channel.cursorId, new Date(), input.db);
  }
  return new Response(null, { status: 204 });
}

function statusRedirect(
  session: Extract<Awaited<ReturnType<typeof resolveIngressSession>>, { kind: "actor" }>,
  returnTo: string,
  provider: GoatGoogleIntegrationProvider,
  status: "connected" | "error",
) {
  return sessionRedirect(
    session,
    new URL(appendGoatGoogleIntegrationStatus(returnTo, provider, status), getGoatAppUrl()),
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
