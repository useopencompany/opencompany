import {
  type Actor,
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
  SCHEDULE_READ_PERMISSION,
  SCHEDULE_WRITE_PERMISSION,
  TASK_READ_PERMISSION,
  TASK_WRITE_PERMISSION,
  WORKFLOW_READ_PERMISSION,
  WORKFLOW_WRITE_PERMISSION,
} from "@opencompany/core";
import type { ChatSqlExecute } from "@opencompany/db/chat-repository";
import { WorkOS } from "@workos-inc/node";
import { sql } from "drizzle-orm";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { ApiError } from "./errors";

const ACTIVE_WORKSPACE_COOKIE = "goat-active-workspace";
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
  refreshedSessionCookie?: string;
};

type AuthenticatorOptions = {
  audience?: string;
  authKitDomain?: string;
  cookieName?: string;
  cookiePassword?: string;
  cookieDomain?: string;
  workos?: WorkOS;
  verifyJwt?: typeof jwtVerify;
};

export function createWorkOsApiAuthenticator(
  execute: ChatSqlExecute,
  options: AuthenticatorOptions = {},
): ApiAuthenticator {
  const cookieName = options.cookieName ?? process.env.WORKOS_COOKIE_NAME ?? DEFAULT_SESSION_COOKIE;
  const audience = options.audience ?? process.env.GOAT_API_OAUTH_AUDIENCE?.trim();
  const authKitDomain = normalizeOrigin(
    options.authKitDomain ?? process.env.GOAT_AUTHKIT_DOMAIN?.trim(),
  );
  const cookiePassword = options.cookiePassword ?? process.env.WORKOS_COOKIE_PASSWORD;
  let workos = options.workos;

  return async (request) => {
    const authorization = request.headers.get("authorization");
    let identity: VerifiedIdentity;
    if (authorization) {
      const token = bearerToken(authorization);
      if (!token) throw unauthorized("Invalid bearer token.");
      if (!audience || !authKitDomain) {
        throw new ApiError(503, "unavailable", "OAuth authentication is not configured.", true);
      }
      try {
        const { payload } = await (options.verifyJwt ?? jwtVerify)(token, jwksFor(authKitDomain), {
          issuer: authKitDomain,
          audience,
        });
        identity = identityFromJwt(payload);
      } catch {
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
      const cookieDomain = options.cookieDomain ?? process.env.WORKOS_COOKIE_DOMAIN;
      identity = await identityFromSession({
        workos,
        sessionData,
        cookiePassword,
        cookieName,
        ...(cookieDomain ? { cookieDomain } : {}),
      });
    }

    const workspaceCookie = parseCookies(request.headers.get("cookie")).get(
      ACTIVE_WORKSPACE_COOKIE,
    );
    const actor = await resolveLocalActor(execute, identity, workspaceCookie ?? null);
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

function identityFromJwt(payload: JWTPayload): VerifiedIdentity {
  const userId = stringClaim(payload.sub);
  const organizationId = stringClaim(payload.org_id);
  const sessionId = stringClaim(payload.sid);
  if (!userId || !organizationId) throw unauthorized("Invalid bearer token claims.");
  return {
    userId,
    organizationId,
    method: "oauth",
    ...(sessionId ? { sessionId } : {}),
  };
}

async function resolveLocalActor(
  execute: ChatSqlExecute,
  identity: VerifiedIdentity,
  requestedWorkspaceId: string | null,
): Promise<Actor> {
  const result = await execute(sql`
    SELECT
      member.workspace_id AS "workspaceId",
      member.role,
      actor_user.task_spawning_enabled AS "taskSpawningEnabled"
    FROM goat.users AS actor_user
    JOIN goat.workspace_members AS member
      ON member.user_workos_id = actor_user.workos_user_id
    JOIN goat.workspaces AS workspace
      ON workspace.id = member.workspace_id
    WHERE actor_user.workos_user_id = ${identity.userId}
      AND actor_user.onboarded_at IS NOT NULL
      AND (
        (${identity.organizationId}::text IS NOT NULL
          AND workspace.workos_organization_id = ${identity.organizationId})
        OR
        (${identity.organizationId}::text IS NULL
          AND ${requestedWorkspaceId}::text IS NOT NULL
          AND workspace.id = ${requestedWorkspaceId})
        OR
        (${identity.organizationId}::text IS NULL
          AND ${requestedWorkspaceId}::text IS NULL)
      )
    ORDER BY
      CASE WHEN workspace.workos_organization_id = ${identity.organizationId} THEN 0 ELSE 1 END,
      CASE WHEN workspace.id = ${requestedWorkspaceId} THEN 0 ELSE 1 END,
      member.created_at ASC,
      member.workspace_id ASC
    LIMIT 1
  `);
  const row = rowsFromExecute<{
    workspaceId: string;
    role: string;
    taskSpawningEnabled: boolean;
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
    permissions: [
      CHAT_READ_PERMISSION,
      CHAT_WRITE_PERMISSION,
      TASK_READ_PERMISSION,
      TASK_WRITE_PERMISSION,
      ...(row.taskSpawningEnabled
        ? [
            WORKFLOW_READ_PERMISSION,
            WORKFLOW_WRITE_PERMISSION,
            SCHEDULE_READ_PERMISSION,
            SCHEDULE_WRITE_PERMISSION,
          ]
        : []),
    ],
    authenticationMethod: identity.method,
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
  };
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(origin: string) {
  const cached = jwks.get(origin);
  if (cached) return cached;
  const value = createRemoteJWKSet(new URL("/oauth2/jwks", `${origin}/`));
  jwks.set(origin, value);
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
