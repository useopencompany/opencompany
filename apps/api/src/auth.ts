import {
  type Actor,
  BRAIN_READ_PERMISSION,
  BRAIN_WRITE_PERMISSION,
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
  SCHEDULE_READ_PERMISSION,
  SCHEDULE_WRITE_PERMISSION,
  SKILL_READ_PERMISSION,
  SKILL_WRITE_PERMISSION,
  TASK_READ_PERMISSION,
  TASK_WRITE_PERMISSION,
  WIKI_READ_PERMISSION,
  WIKI_WRITE_PERMISSION,
  WORKFLOW_READ_PERMISSION,
  WORKFLOW_WRITE_PERMISSION,
} from "@opencompany/core";
import type { ChatSqlExecute } from "@opencompany/db/chat-repository";
import { WorkOS } from "@workos-inc/node";
import { sql } from "drizzle-orm";
import { createRemoteJWKSet, decodeJwt, type JWTPayload, jwtVerify } from "jose";
import { ApiError } from "./errors";

const ACTIVE_WORKSPACE_COOKIE = "goat-active-workspace";
const ACTIVE_BRAIN_COOKIE = "goat-active-brain";
const DEFAULT_SESSION_COOKIE = "wos-session";
const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export type ApiAuthentication = {
  actor: Actor;
  refreshedSessionCookie?: string;
};

export type ApiAuthenticator = (request: Request) => Promise<ApiAuthentication>;

type VerifiedIdentity = {
  userId: string;
  organizationId: string | null;
  sessionId?: string;
  method: Actor["authenticationMethod"];
  credentialKind: "browser_cookie" | "connect_bearer" | "authkit_bearer";
  refreshedSessionCookie?: string;
};

// Verified caller identity plus the requested workspace, before any local
// actor/onboarding resolution. Provider-ingress routes use this directly so
// mid-onboarding users can still finish OAuth connect flows, matching the
// retired web routes' currentUser() semantics.
export type ApiIdentity = VerifiedIdentity & {
  activeWorkspaceId: string | null;
  activeBrainId: string | null;
};

export type ApiIdentityVerifier = (request: Request) => Promise<ApiIdentity>;

type AuthenticatorOptions = {
  audience?: string;
  authKitDomain?: string;
  cookieName?: string;
  cookiePassword?: string;
  cookieDomain?: string;
  mobileClientId?: string;
  workos?: WorkOS;
  verifyJwt?: typeof jwtVerify;
};

export function createWorkOsApiIdentityVerifier(
  options: AuthenticatorOptions = {},
): ApiIdentityVerifier {
  const cookieName =
    options.cookieName?.trim() || process.env.WORKOS_COOKIE_NAME?.trim() || DEFAULT_SESSION_COOKIE;
  const audience = options.audience ?? process.env.OPENCOMPANY_API_OAUTH_AUDIENCE?.trim();
  const authKitDomain = normalizeOrigin(
    options.authKitDomain ?? process.env.OPENCOMPANY_AUTHKIT_DOMAIN?.trim(),
  );
  const cookiePassword = options.cookiePassword ?? process.env.WORKOS_COOKIE_PASSWORD;
  const mobileClientId =
    options.mobileClientId?.trim() || process.env.WORKOS_MOBILE_CLIENT_ID?.trim() || null;
  let workos = options.workos;

  return async (request) => {
    const authorization = request.headers.get("authorization");
    let identity: VerifiedIdentity;
    if (authorization) {
      const token = bearerToken(authorization);
      if (!token) throw unauthorized("Invalid bearer token.");
      try {
        const unverifiedClientId = stringClaim(decodeJwt(token).client_id);
        if (mobileClientId && unverifiedClientId === mobileClientId) {
          const { payload } = await (options.verifyJwt ?? jwtVerify)(
            token,
            authKitJwksFor(mobileClientId),
          );
          identity = identityFromAuthKitJwt(payload, mobileClientId);
        } else {
          if (!audience || !authKitDomain) {
            throw new ApiError(503, "unavailable", "OAuth authentication is not configured.", true);
          }
          const { payload } = await (options.verifyJwt ?? jwtVerify)(
            token,
            connectJwksFor(authKitDomain),
            {
              issuer: authKitDomain,
              audience,
            },
          );
          identity = identityFromConnectJwt(payload);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) throw error;
        throw unauthorized("Invalid bearer token.");
      }
    } else {
      const cookies = parseCookies(request.headers.get("cookie"));
      const sessionData = cookies.get(cookieName);
      if (!sessionData) throw unauthorized("Authentication required.");
      if (!cookiePassword) {
        throw new ApiError(503, "unavailable", "Browser authentication is not configured.", true);
      }
      if (!workos) {
        const apiKey = process.env.WORKOS_API_KEY;
        const clientId = process.env.WORKOS_CLIENT_ID;
        if (!apiKey || !clientId) {
          throw new ApiError(503, "unavailable", "Browser authentication is not configured.", true);
        }
        workos = new WorkOS(apiKey, { clientId });
      }
      const cookieDomain =
        options.cookieDomain?.trim() || process.env.WORKOS_COOKIE_DOMAIN?.trim() || undefined;
      identity = await identityFromSession({
        workos,
        sessionData,
        cookiePassword,
        cookieName,
        ...(cookieDomain ? { cookieDomain } : {}),
      });
    }

    const cookies = authorization ? null : parseCookies(request.headers.get("cookie"));
    return {
      ...identity,
      activeWorkspaceId: cookies?.get(ACTIVE_WORKSPACE_COOKIE) ?? null,
      activeBrainId: cookies?.get(ACTIVE_BRAIN_COOKIE) ?? null,
    };
  };
}

export function createWorkOsApiAuthenticator(
  execute: ChatSqlExecute,
  options: AuthenticatorOptions = {},
): ApiAuthenticator {
  const identify = createWorkOsApiIdentityVerifier(options);
  return async (request) => {
    const identity = await identify(request);
    if (identity.credentialKind !== "browser_cookie" && !identity.organizationId) {
      throw unauthorized("Invalid bearer token claims.");
    }
    const actor = await resolveLocalActor(execute, identity, identity.activeWorkspaceId);
    return {
      actor,
      ...(identity.refreshedSessionCookie
        ? { refreshedSessionCookie: identity.refreshedSessionCookie }
        : {}),
    };
  };
}

async function identityFromSession(input: {
  workos: WorkOS;
  sessionData: string;
  cookiePassword: string;
  cookieName: string;
  cookieDomain?: string;
}): Promise<VerifiedIdentity> {
  const session = await input.workos.userManagement.loadSealedSession({
    sessionData: input.sessionData,
    cookiePassword: input.cookiePassword,
  });
  const result = await session.authenticate();
  if (result.authenticated) {
    return {
      userId: result.user.id,
      organizationId: result.organizationId ?? null,
      sessionId: result.sessionId,
      method: "session",
      credentialKind: "browser_cookie",
    };
  }
  if (result.reason === "invalid_jwt") {
    const refreshed = await session.refresh();
    if (refreshed.authenticated) {
      return {
        userId: refreshed.user.id,
        organizationId: refreshed.organizationId ?? null,
        sessionId: refreshed.sessionId,
        method: "session",
        credentialKind: "browser_cookie",
        ...(refreshed.sealedSession
          ? {
              refreshedSessionCookie: serializeSessionCookie(
                input.cookieName,
                refreshed.sealedSession,
                input.cookieDomain,
              ),
            }
          : {}),
      };
    }
  }
  throw unauthorized("Authentication required.");
}

function identityFromConnectJwt(payload: JWTPayload): VerifiedIdentity {
  const userId = stringClaim(payload.sub);
  const organizationId = stringClaim(payload.org_id);
  const sessionId = stringClaim(payload.sid);
  if (!userId) throw unauthorized("Invalid bearer token claims.");
  return {
    userId,
    organizationId,
    method: "oauth",
    credentialKind: "connect_bearer",
    ...(sessionId ? { sessionId } : {}),
  };
}

function identityFromAuthKitJwt(payload: JWTPayload, mobileClientId: string): VerifiedIdentity {
  const userId = stringClaim(payload.sub);
  const organizationId = stringClaim(payload.org_id);
  const sessionId = stringClaim(payload.sid);
  const clientId = stringClaim(payload.client_id);
  if (!userId || !sessionId || clientId !== mobileClientId) {
    throw unauthorized("Invalid bearer token claims.");
  }
  return {
    userId,
    organizationId,
    sessionId,
    method: "session",
    credentialKind: "authkit_bearer",
  };
}

async function resolveLocalActor(
  execute: ChatSqlExecute,
  identity: VerifiedIdentity,
  requestedWorkspaceId: string | null,
): Promise<Actor> {
  // OAuth bearer tokens carry the organization as an authorization scope, so
  // it must match the resolved workspace exactly. Browser sessions carry it as
  // "last selected organization" UX state; pre-refactor users can still select
  // legacy WorkOS organizations that map to no workspace row, which must fall
  // back to the active-workspace cookie and then the earliest membership
  // (mirroring the identity, ingress-session, and onboarding resolvers)
  // instead of locking sign-in behind a 403.
  const strictOrganizationScope = identity.method === "oauth";
  const result = await execute(sql`
    SELECT
      member.workspace_id AS "workspaceId",
      member.role,
      actor_user.task_spawning_enabled AS "taskSpawningEnabled",
      workspace.legacy_brain_enabled AS "legacyBrainEnabled"
    FROM goat.users AS actor_user
    JOIN goat.workspace_members AS member
      ON member.user_workos_id = actor_user.workos_user_id
    JOIN goat.workspaces AS workspace
      ON workspace.id = member.workspace_id
    WHERE actor_user.workos_user_id = ${identity.userId}
      AND actor_user.onboarded_at IS NOT NULL
      AND (
        ${strictOrganizationScope} = false
        OR (${identity.organizationId}::text IS NOT NULL
          AND workspace.workos_organization_id = ${identity.organizationId})
      )
    ORDER BY
      CASE
        WHEN ${identity.organizationId}::text IS NOT NULL
          AND workspace.workos_organization_id = ${identity.organizationId}
        THEN 0 ELSE 1
      END,
      CASE WHEN workspace.id = ${requestedWorkspaceId} THEN 0 ELSE 1 END,
      member.created_at ASC,
      member.workspace_id ASC
    LIMIT 1
  `);
  const row = rowsFromExecute<{
    workspaceId: string;
    role: string;
    taskSpawningEnabled: boolean;
    legacyBrainEnabled: boolean;
  }>(result)[0];
  if (!row) {
    throw new ApiError(
      403,
      "forbidden",
      "Finish onboarding and select an accessible workspace before using Chat.",
    );
  }
  return {
    userId: identity.userId,
    workspaceId: row.workspaceId,
    role: row.role,
    permissions: actorPermissions(row),
    authenticationMethod: identity.method,
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
  };
}

// Role- and flag-derived permission set, the single source of truth shared by
// the request authenticator and the internal service-actor resolver.
function actorPermissions(row: {
  role: string;
  legacyBrainEnabled: boolean;
  taskSpawningEnabled: boolean;
}): string[] {
  return [
    CHAT_READ_PERMISSION,
    CHAT_WRITE_PERMISSION,
    TASK_READ_PERMISSION,
    TASK_WRITE_PERMISSION,
    SKILL_READ_PERMISSION,
    WIKI_READ_PERMISSION,
    WIKI_WRITE_PERMISSION,
    ...(row.legacyBrainEnabled ? [BRAIN_READ_PERMISSION] : []),
    ...(row.role === "admin" ? [SKILL_WRITE_PERMISSION] : []),
    ...(row.role === "admin" && row.legacyBrainEnabled ? [BRAIN_WRITE_PERMISSION] : []),
    ...(row.taskSpawningEnabled
      ? [
          WORKFLOW_READ_PERMISSION,
          WORKFLOW_WRITE_PERMISSION,
          SCHEDULE_READ_PERMISSION,
          SCHEDULE_WRITE_PERMISSION,
        ]
      : []),
  ];
}

// Reconstructs an Actor for an explicit (userWorkosId, workspaceId) pair from
// Postgres, for internal service calls (e.g. the runner→API wiki command
// endpoint) that name their tenancy but must never be trusted for permissions.
// Requires the user to exist and hold a membership of the named workspace.
// Invite acceptance can create that membership before onboarding finishes, so
// membership remains the Wiki authorization boundary in that valid state.
export async function resolveWikiServiceActor(
  execute: ChatSqlExecute,
  input: { userWorkosId: string; workspaceId: string },
): Promise<Actor> {
  const result = await execute(sql`
    SELECT
      member.workspace_id AS "workspaceId",
      member.role,
      actor_user.task_spawning_enabled AS "taskSpawningEnabled",
      workspace.legacy_brain_enabled AS "legacyBrainEnabled"
    FROM goat.users AS actor_user
    JOIN goat.workspace_members AS member
      ON member.user_workos_id = actor_user.workos_user_id
    JOIN goat.workspaces AS workspace
      ON workspace.id = member.workspace_id
    WHERE actor_user.workos_user_id = ${input.userWorkosId}
      AND workspace.id = ${input.workspaceId}
    LIMIT 1
  `);
  const row = rowsFromExecute<{
    workspaceId: string;
    role: string;
    taskSpawningEnabled: boolean;
    legacyBrainEnabled: boolean;
  }>(result)[0];
  if (!row) {
    throw new ApiError(403, "forbidden", "The user cannot access the wiki in this workspace.");
  }
  return {
    userId: input.userWorkosId,
    workspaceId: row.workspaceId,
    role: row.role,
    permissions: actorPermissions(row),
    authenticationMethod: "service",
  };
}

const connectJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const authKitJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function connectJwksFor(origin: string) {
  const cached = connectJwks.get(origin);
  if (cached) return cached;
  const value = createRemoteJWKSet(new URL("/oauth2/jwks", `${origin}/`));
  connectJwks.set(origin, value);
  return value;
}

function authKitJwksFor(clientId: string) {
  const cached = authKitJwks.get(clientId);
  if (cached) return cached;
  const value = createRemoteJWKSet(
    new URL(`/sso/jwks/${encodeURIComponent(clientId)}`, "https://api.workos.com"),
  );
  authKitJwks.set(clientId, value);
  return value;
}

function normalizeOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

function bearerToken(value: string) {
  return /^Bearer\s+(\S+)$/iu.exec(value.trim())?.[1] ?? null;
}

function stringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unauthorized(message: string) {
  return new ApiError(401, "authentication_required", message, false, {
    "WWW-Authenticate": "Bearer",
  });
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      cookies.set(name, raw);
    }
  }
  return cookies;
}

function serializeSessionCookie(name: string, value: string, domain?: string) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    process.env.NODE_ENV === "production" ? "Secure" : "",
    domain ? `Domain=${domain}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function rowsFromExecute<Row>(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  return [];
}
