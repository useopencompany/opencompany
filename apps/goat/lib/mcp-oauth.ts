import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { generateProtectedResourceMetadata, getPublicUrl } from "mcp-handler";

export const GOAT_AUTHKIT_DOMAIN_ENV = "GOAT_AUTHKIT_DOMAIN";

export const GOAT_MCP_METADATA_CORS_HEADERS = {
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

export function resolveGoatAuthKitDomain(
  value = process.env[GOAT_AUTHKIT_DOMAIN_ENV],
): { ok: true; domain: string } | { ok: false; error: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { ok: false, error: `${GOAT_AUTHKIT_DOMAIN_ENV} is not configured.` };
  }

  try {
    const url = new URL(trimmed);
    if (url.pathname !== "/" || url.search || url.hash) {
      return { ok: false, error: `${GOAT_AUTHKIT_DOMAIN_ENV} must be a URL origin.` };
    }
    return { ok: true, domain: url.origin };
  } catch {
    return { ok: false, error: `${GOAT_AUTHKIT_DOMAIN_ENV} must be a valid URL.` };
  }
}

export function buildGoatMcpEndpointPath(brainRef: string) {
  return `/api/mcp/${encodeURIComponent(brainRef)}/mcp`;
}

export function buildGoatMcpResourceMetadataPath(brainRef: string) {
  return `/.well-known/oauth-protected-resource${buildGoatMcpEndpointPath(brainRef)}`;
}

export function goatMcpResourceUrlFromMetadataRequest(request: Request) {
  const publicUrl = getPublicUrl(request);
  publicUrl.pathname = publicUrl.pathname.replace(/^\/\.well-known\/oauth-protected-resource/, "");
  publicUrl.search = "";
  publicUrl.hash = "";

  if (publicUrl.pathname === "/") {
    return publicUrl.toString().replace(/\/$/, "");
  }
  return publicUrl.toString();
}

export function goatMcpResourceIndicatorUrlFromRequest(request: Request) {
  const publicUrl = getPublicUrl(request);
  publicUrl.pathname = "/api/mcp";
  publicUrl.search = "";
  publicUrl.hash = "";
  return publicUrl.toString();
}

export function goatMcpProtectedResourceMetadata(request: Request, authKitDomain: string) {
  return generateProtectedResourceMetadata({
    authServerUrls: [authKitDomain],
    resourceUrl: goatMcpResourceIndicatorUrlFromRequest(request),
    additionalMetadata: {
      bearer_methods_supported: ["header"],
    },
  });
}

export async function verifyGoatMcpBearerToken(
  _request: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  const domain = resolveGoatAuthKitDomain();
  if (!domain.ok) {
    throw new Error(domain.error);
  }

  try {
    const { payload } = await jwtVerify(bearerToken, jwksForAuthKitDomain(domain.domain), {
      issuer: domain.domain,
      audience: goatMcpResourceIndicatorUrlFromRequest(_request),
    });
    const userWorkosId = workosUserIdFromPayload(payload);
    if (!userWorkosId) return undefined;
    const workosOrganizationId = workosOrganizationIdFromPayload(payload);

    return {
      token: bearerToken,
      clientId: userWorkosId,
      scopes: scopesFromPayload(payload),
      ...(typeof payload.exp === "number" ? { expiresAt: payload.exp } : {}),
      extra: {
        userWorkosId,
        workosOrganizationId,
      },
    };
  } catch {
    return undefined;
  }
}

export function userWorkosIdFromMcpAuth(auth: AuthInfo | undefined) {
  const extraUserId = auth?.extra?.userWorkosId;
  if (typeof extraUserId === "string" && extraUserId.trim()) return extraUserId;
  return auth?.clientId || null;
}

export function workosOrganizationIdFromMcpAuth(auth: AuthInfo | undefined) {
  const extraOrganizationId = auth?.extra?.workosOrganizationId;
  if (typeof extraOrganizationId === "string" && extraOrganizationId.trim()) {
    return extraOrganizationId;
  }
  return null;
}

export function jwksForAuthKitDomain(authKitDomain: string) {
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

function workosOrganizationIdFromPayload(payload: JWTPayload) {
  const organizationId = payload.org_id;
  return typeof organizationId === "string" && organizationId.trim() ? organizationId : null;
}

function scopesFromPayload(payload: JWTPayload) {
  const scope = payload.scope;
  if (typeof scope !== "string") return [];
  return scope
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
}
