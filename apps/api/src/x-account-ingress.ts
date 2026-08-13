import { connectGoatXAccountIntegration } from "@opencompany/db/goat-integrations";
import { getGoatAppUrl } from "@opencompany/goat-agent/app-url";
import { captureGoatIntegrationAddedAnalytics } from "@opencompany/goat-agent/integrations/analytics";
import {
  appendGoatXAccountIntegrationStatus,
  buildGoatXAccountAuthorizationUrl,
  createGoatXAccountIntegrationState,
  createGoatXAccountPkce,
  exchangeGoatXAccountCode,
  fetchGoatXAccountIdentity,
  isGoatXAccountIntegrationConfigured,
  verifyGoatXAccountIntegrationState,
} from "@opencompany/goat-agent/integrations/x-account";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "x-account-ingress" });

type DbLike = any;

// Short-lived cookie carrying the PKCE code_verifier across the X OAuth
// redirect. X's authorization `state` parameter is capped at 500 characters
// and is bounced back through the browser, so the verifier travels in an
// httpOnly cookie instead. The web relay streams Set-Cookie back unchanged,
// so the cookie lives on the web origin exactly as the retired route set it.
const PKCE_COOKIE = "goat_x_pkce_verifier";
const PKCE_COOKIE_MAX_AGE_SECONDS = 600;

// Provider ingress composition for the personal X (Twitter) account
// connection: OAuth 2.0 authorization-code flow with mandatory PKCE.
export type XAccountIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
};

export function createXAccountIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
}): XAccountIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier };

async function handleStart(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGoatXAccountIntegrationConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createGoatXAccountIntegrationState({
    userWorkosId: session.userId,
    returnTo,
  });
  const { codeVerifier, codeChallenge } = createGoatXAccountPkce();

  return withSetCookie(
    sessionRedirect(session, buildGoatXAccountAuthorizationUrl(state, codeChallenge)),
    pkceCookie(codeVerifier),
  );
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";
  const codeVerifier = readPkceVerifier(request);
  // The verifier cookie is one-shot: every callback outcome deletes it.
  const consumed = (response: Response) => withSetCookie(response, pkceDeletionCookie());

  let state: ReturnType<typeof verifyGoatXAccountIntegrationState>;
  try {
    state = verifyGoatXAccountIntegrationState(stateValue);
  } catch {
    return consumed(
      sessionRedirect(
        session,
        new URL(
          "/settings?integration=x_account&setup=error&reason=invalid_state",
          getGoatAppUrl(),
        ),
      ),
    );
  }

  if (state.userWorkosId !== session.userId) {
    return consumed(statusRedirect(session, state.returnTo, "error", "session_mismatch"));
  }
  if (!isGoatXAccountIntegrationConfigured()) {
    return consumed(statusRedirect(session, state.returnTo, "error", "not_configured"));
  }
  if (url.searchParams.get("error")) {
    return consumed(statusRedirect(session, state.returnTo, "error", "x_account_denied"));
  }
  const code = url.searchParams.get("code");
  if (!code || !codeVerifier) {
    return consumed(statusRedirect(session, state.returnTo, "error", "missing_code"));
  }

  try {
    const oauth = await exchangeGoatXAccountCode(code, codeVerifier);
    const identity = await fetchGoatXAccountIdentity(oauth.accessToken);

    await connectGoatXAccountIntegration({
      userWorkosId: session.userId,
      xUserId: identity.id,
      username: identity.username,
      name: identity.name,
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
      db: input.db,
    });
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId: session.userId,
      workspaceId: session.workspaceId,
      provider: "x_account",
    });

    return consumed(statusRedirect(session, state.returnTo, "connected"));
  } catch (error) {
    logger.warn("X account connection failed", {
      event: "goat.x_account_callback_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return consumed(statusRedirect(session, state.returnTo, "error", "connection_sync_failed"));
  }
}

// Same attributes as the retired next/headers implementation: Path=/,
// httpOnly, SameSite=Lax, Secure in production, ten-minute lifetime.
function pkceCookie(codeVerifier: string) {
  return `${PKCE_COOKIE}=${codeVerifier}; Path=/; Max-Age=${PKCE_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secureSuffix()}`;
}

function pkceDeletionCookie() {
  // Must match the path the cookie was set with, or this is a no-op deletion
  // of a different cookie and the original stays consumable.
  return `${PKCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureSuffix()}`;
}

function secureSuffix() {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

function readPkceVerifier(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== PKCE_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

// Response.redirect() headers are immutable; rewrap before appending the
// PKCE cookie so it composes with the refreshed-session cookie that
// sessionRedirect may already have attached.
function withSetCookie(response: Response, cookie: string) {
  const withCookie = new Response(response.body, response);
  withCookie.headers.append("Set-Cookie", cookie);
  return withCookie;
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendGoatXAccountIntegrationStatus(returnTo, status, reason), getGoatAppUrl()),
  );
}
