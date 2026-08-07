import { getDb } from "@opencompany/db/client";
import { goatUsers, goatWorkspaceMembers, goatWorkspaces } from "@opencompany/db/schema";
import { DEFAULT_GOAT_BRAIN_SLUG, listAccessibleGoatBrains } from "@opencompany/db/workspaces";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { currentGoatUser, type GoatAuthContext } from "@/lib/auth";
import { resolveGoatAuthKitDomain } from "@/lib/mcp-oauth";

export const GOAT_MACOS_OAUTH_AUDIENCE_ENV = "GOAT_MACOS_OAUTH_AUDIENCE";

export type GoatChatRequestContext = Pick<
  GoatAuthContext,
  "user" | "workspace" | "role" | "workspaces" | "brains" | "activeBrain"
>;

type ChatAuthResult =
  | { ok: true; context: GoatChatRequestContext }
  | { ok: false; response: Response };

type TokenVerification = { ok: true; payload: JWTPayload } | { ok: false; response: Response };

let jwksCache:
  | {
      authKitDomain: string;
      jwks: ReturnType<typeof createRemoteJWKSet>;
    }
  | undefined;

export async function resolveGoatChatRequestContext(request: Request): Promise<ChatAuthResult> {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    const context = await currentGoatUser({ optional: true });
    return context
      ? { ok: true, context }
      : { ok: false, response: unauthorizedResponse("Unauthorized") };
  }

  const token = bearerToken(authorization);
  if (!token) {
    return { ok: false, response: unauthorizedResponse("Invalid bearer token.") };
  }

  const verified = await verifyGoatMacAccessToken(token);
  if (!verified.ok) return verified;
  return resolveGoatMacChatContext(verified.payload);
}

export async function verifyGoatMacAccessToken(
  token: string,
  options: {
    audience?: string | null;
    authKitDomain?: string | null;
    verifyJwt?: typeof jwtVerify;
  } = {},
): Promise<TokenVerification> {
  const audience = options.audience ?? process.env[GOAT_MACOS_OAUTH_AUDIENCE_ENV]?.trim();
  if (!audience) {
    return {
      ok: false,
      response: new Response("Goat Quick authentication is not configured.", { status: 503 }),
    };
  }

  const configuredDomain = options.authKitDomain
    ? resolveGoatAuthKitDomain(options.authKitDomain)
    : resolveGoatAuthKitDomain();
  if (!configuredDomain.ok) {
    return { ok: false, response: new Response(configuredDomain.error, { status: 503 }) };
  }

  try {
    const verifyJwt = options.verifyJwt ?? jwtVerify;
    const { payload } = await verifyJwt(token, jwksForAuthKitDomain(configuredDomain.domain), {
      issuer: configuredDomain.domain,
      audience,
    });
    return { ok: true, payload };
  } catch {
    return { ok: false, response: unauthorizedResponse("Invalid bearer token.") };
  }
}

export async function resolveGoatMacChatContext(
  payload: JWTPayload,
  db = getDb(),
): Promise<ChatAuthResult> {
  const userWorkosId = normalizedClaim(payload.sub);
  const organizationId = normalizedClaim(payload.org_id);
  if (!userWorkosId || !organizationId) {
    return { ok: false, response: unauthorizedResponse("Invalid bearer token claims.") };
  }

  const [userRows, membershipRows] = await Promise.all([
    db.select().from(goatUsers).where(eq(goatUsers.workosUserId, userWorkosId)).limit(1),
    db
      .select({ workspace: goatWorkspaces, role: goatWorkspaceMembers.role })
      .from(goatWorkspaceMembers)
      .innerJoin(goatWorkspaces, eq(goatWorkspaces.id, goatWorkspaceMembers.workspaceId))
      .where(
        and(
          eq(goatWorkspaceMembers.userWorkosId, userWorkosId),
          eq(goatWorkspaces.workosOrganizationId, organizationId),
        ),
      )
      .limit(1),
  ]);
  const user = userRows[0];
  if (!user) {
    return {
      ok: false,
      response: new Response("Open Goat in your browser before using Goat Quick.", { status: 403 }),
    };
  }
  if (!user.onboardedAt) {
    return {
      ok: false,
      response: new Response("Finish Goat onboarding in your browser first.", { status: 403 }),
    };
  }

  const membership = membershipRows[0];
  if (!membership) {
    return {
      ok: false,
      response: new Response("The selected Goat workspace is unavailable.", { status: 403 }),
    };
  }

  const brains = await listAccessibleGoatBrains(
    { userWorkosId, workspaceId: membership.workspace.id },
    { db },
  );
  const activeBrain =
    brains.find((brain) => brain.slug === DEFAULT_GOAT_BRAIN_SLUG) ?? brains[0] ?? null;
  if (!activeBrain) {
    return {
      ok: false,
      response: new Response("You do not have access to a Brain in this workspace.", {
        status: 403,
      }),
    };
  }

  return {
    ok: true,
    context: {
      user,
      workspace: membership.workspace,
      role: membership.role,
      workspaces: [membership],
      brains,
      activeBrain,
    },
  };
}

function jwksForAuthKitDomain(authKitDomain: string) {
  if (jwksCache?.authKitDomain === authKitDomain) return jwksCache.jwks;

  jwksCache = {
    authKitDomain,
    jwks: createRemoteJWKSet(new URL("/oauth2/jwks", `${authKitDomain}/`)),
  };
  return jwksCache.jwks;
}

function bearerToken(value: string) {
  const match = /^Bearer\s+(\S+)$/iu.exec(value.trim());
  return match?.[1] ?? null;
}

function normalizedClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unauthorizedResponse(message: string) {
  return new Response(message, {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
  });
}
