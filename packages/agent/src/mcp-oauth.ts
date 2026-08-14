import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { generateProtectedResourceMetadata, getPublicUrl } from "mcp-handler";
import { USER_MCP_ENDPOINT_PATH } from "./mcp-setup";

export const AUTHKIT_DOMAIN_ENV = "OPENCOMPANY_AUTHKIT_DOMAIN";

export const MCP_METADATA_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
} as const;

let jwksCache:
  | {
      authKitDomain: string;
      jwks: ReturnType<typeof createRemoteJWKSet>;
    }
  | undefined;

export function resolveAuthKitDomain(
  value = process.env[AUTHKIT_DOMAIN_ENV],
): { ok: true; domain: string } | { ok: false; error: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { ok: false, error: `${AUTHKIT_DOMAIN_ENV} is not configured.` };
  }

  try {
    const url = new URL(trimmed);
    if (url.pathname !== "/" || url.search || url.hash) {
      return { ok: false, error: `${AUTHKIT_DOMAIN_ENV} must be a URL origin.` };
    }
    return { ok: true, domain: url.origin };
  } catch {
    return { ok: false, error: `${AUTHKIT_DOMAIN_ENV} must be a valid URL.` };
  }
}

export function buildUserMcpResourceMetadataPath() {
  return `/.well-known/oauth-protected-resource${USER_MCP_ENDPOINT_PATH}`;
}

export function mcpResourceUrlFromMetadataRequest(request: Request) {
  const publicUrl = getPublicUrl(request);
  publicUrl.pathname = publicUrl.pathname.replace(/^\/\.well-known\/oauth-protected-resource/, "");
  publicUrl.search = "";
  publicUrl.hash = "";

  if (publicUrl.pathname === "/") {
    return publicUrl.toString().replace(/\/$/, "");
  }
  return publicUrl.toString();
}

export function mcpResourceIndicatorUrlFromRequest(request: Request) {
  const publicUrl = getPublicUrl(request);
  publicUrl.pathname = USER_MCP_ENDPOINT_PATH;
  publicUrl.search = "";
  publicUrl.hash = "";
  return publicUrl.toString();
}

export function mcpProtectedResourceMetadata(request: Request, authKitDomain: string) {
  return generateProtectedResourceMetadata({
    authServerUrls: [authKitDomain],
    resourceUrl: mcpResourceIndicatorUrlFromRequest(request),
    additionalMetadata: {
      bearer_methods_supported: ["header"],
    },
  });
}

export async function verifyMcpBearerToken(
  _request: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  const domain = resolveAuthKitDomain();
  if (!domain.ok) {
    throw new Error(domain.error);
  }

  try {
    const { payload } = await jwtVerify(bearerToken, jwksForAuthKitDomain(domain.domain), {
      issuer: domain.domain,
      audience: mcpResourceIndicatorUrlFromRequest(_request),
    });
    const userWorkosId = workosUserIdFromPayload(payload);
    if (!userWorkosId) return undefined;

    return {
      token: bearerToken,
      clientId: userWorkosId,
      scopes: scopesFromPayload(payload),
      ...(typeof payload.exp === "number" ? { expiresAt: payload.exp } : {}),
      extra: {
        userWorkosId,
      },
    };
  } catch (error) {
    // All verification failures collapse to a 401, which forces the client to
    // reconnect. Log the distinguishing details so we can tell an expected
    // token expiry apart from an audience/issuer mismatch (unstable public
    // host) or a JWKS-fetch/key-rotation blip.
    const details = error as { code?: unknown; claim?: unknown } | undefined;
    console.warn("[opencompany-mcp] bearer token rejected", {
      code: typeof details?.code === "string" ? details.code : undefined,
      claim: typeof details?.claim === "string" ? details.claim : undefined,
      expectedAudience: mcpResourceIndicatorUrlFromRequest(_request),
      expectedIssuer: domain.domain,
    });
    return undefined;
  }
}

export function userWorkosIdFromMcpAuth(auth: AuthInfo | undefined) {
  const extraUserId = auth?.extra?.userWorkosId;
  if (typeof extraUserId === "string" && extraUserId.trim()) return extraUserId;
  return auth?.clientId || null;
}

function jwksForAuthKitDomain(authKitDomain: string) {
  if (jwksCache?.authKitDomain === authKitDomain) return jwksCache.jwks;

  jwksCache = {
    authKitDomain,
    jwks: createRemoteJWKSet(new URL("/oauth2/jwks", `${authKitDomain}/`)),
  };
  return jwksCache.jwks;
}

function workosUserIdFromPayload(payload: JWTPayload) {
  return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub : null;
}

function scopesFromPayload(payload: JWTPayload) {
  const scope = payload.scope;
  if (typeof scope !== "string") return [];
  return scope
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
}
