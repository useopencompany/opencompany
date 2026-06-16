import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  personalMcpOAuthAuthorizationCodes,
  personalMcpOAuthClients,
  personalMcpOAuthTokens,
} from "@opencompany/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getAppUrl } from "@/lib/billing/stripe";

const CLIENT_ID_PREFIX = "oc_mcp_client_";
const AUTH_CODE_PREFIX = "oc_mcp_code_";
const ACCESS_TOKEN_PREFIX = "oc_mcp_at_";
const REFRESH_TOKEN_PREFIX = "oc_mcp_rt_";
const SECRET_BYTES = 32;
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const OPENCOMPANY_MCP_SCOPE = "mcp:read";
const OPTIONAL_IDENTITY_SCOPES = new Set(["openid", "profile", "email"]);

export type PersonalMcpOAuthAuth = {
  tokenId: string;
  clientId: string;
  workspaceId: string;
  userId: string;
  scope: string;
};

export type DynamicClientRegistrationRequest = {
  client_name?: unknown;
  client_uri?: unknown;
  logo_uri?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
  token_endpoint_auth_method?: unknown;
};

export class McpOAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function openCompanyMcpResource() {
  return `${getAppUrl()}/api/mcp/opencompany`;
}

export function openCompanyMcpProtectedResourceMetadataUrl() {
  return `${getAppUrl()}/.well-known/oauth-protected-resource`;
}

export function oauthCorsHeaders() {
  return {
    "Cache-Control": "private, no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
  };
}

export function mcpBearerChallenge() {
  return `Bearer realm="OpenCompany MCP", resource_metadata="${openCompanyMcpProtectedResourceMetadataUrl()}", scope="${OPENCOMPANY_MCP_SCOPE}"`;
}

export async function registerPersonalMcpOAuthClient(input: DynamicClientRegistrationRequest) {
  const redirectUris = normalizeRedirectUris(input.redirect_uris);
  const grantTypes = normalizeStringArray(input.grant_types, [
    "authorization_code",
    "refresh_token",
  ]);
  const responseTypes = normalizeStringArray(input.response_types, ["code"]);
  const tokenEndpointAuthMethod =
    typeof input.token_endpoint_auth_method === "string"
      ? input.token_endpoint_auth_method
      : "none";

  if (!grantTypes.includes("authorization_code")) {
    throw new McpOAuthError("invalid_client_metadata", "authorization_code grant is required.");
  }
  if (!responseTypes.includes("code")) {
    throw new McpOAuthError("invalid_client_metadata", "code response type is required.");
  }
  if (tokenEndpointAuthMethod !== "none") {
    throw new McpOAuthError(
      "invalid_client_metadata",
      "OpenCompany MCP currently supports public PKCE clients with token_endpoint_auth_method none.",
    );
  }

  const now = new Date();
  const clientId = `${CLIENT_ID_PREFIX}${randomBytes(18).toString("base64url")}`;
  const [row] = await getDb()
    .insert(personalMcpOAuthClients)
    .values({
      id: newId("pmcpoc"),
      clientId,
      clientName: normalizeString(input.client_name, "MCP client", 120),
      clientUri: normalizeOptionalUrl(input.client_uri),
      logoUri: normalizeOptionalUrl(input.logo_uri),
      redirectUris,
      grantTypes,
      responseTypes,
      scope: normalizeScope(typeof input.scope === "string" ? input.scope : undefined),
      tokenEndpointAuthMethod,
      updatedAt: now,
    })
    .returning();

  if (!row) throw new McpOAuthError("server_error", "Could not register OAuth client.", 500);
  return clientRegistrationResponse(row);
}

export async function validateAuthorizeRequest(url: URL) {
  if (url.searchParams.get("response_type") !== "code") {
    throw new McpOAuthError("unsupported_response_type", "Only response_type=code is supported.");
  }

  const clientId = requiredParam(url, "client_id");
  const redirectUri = requiredParam(url, "redirect_uri");
  const codeChallenge = requiredParam(url, "code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "plain";
  if (codeChallengeMethod !== "S256") {
    throw new McpOAuthError("invalid_request", "OpenCompany MCP requires PKCE S256.");
  }

  const client = await findClient(clientId);
  if (!client) throw new McpOAuthError("invalid_client", "Unknown OAuth client.", 401);
  if (!client.redirectUris.includes(redirectUri)) {
    throw new McpOAuthError("invalid_request", "redirect_uri is not registered for this client.");
  }

  const resource = normalizeResource(url.searchParams.get("resource"));
  return {
    client,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    resource,
    scope: normalizeScope(url.searchParams.get("scope") ?? client.scope),
    state: url.searchParams.get("state"),
  };
}

export async function createPersonalMcpAuthorizationCode(input: {
  clientId: string;
  workspaceId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
}) {
  const code = `${AUTH_CODE_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  await getDb()
    .insert(personalMcpOAuthAuthorizationCodes)
    .values({
      codeHash: hashSecret(code),
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      scope: input.scope,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      resource: input.resource,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
  return code;
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
}) {
  const now = new Date();
  const codeHash = hashSecret(input.code);
  const [row] = await getDb()
    .select()
    .from(personalMcpOAuthAuthorizationCodes)
    .where(
      and(
        eq(personalMcpOAuthAuthorizationCodes.codeHash, codeHash),
        eq(personalMcpOAuthAuthorizationCodes.clientId, input.clientId),
        gt(personalMcpOAuthAuthorizationCodes.expiresAt, now),
        isNull(personalMcpOAuthAuthorizationCodes.usedAt),
      ),
    )
    .limit(1);

  if (!row || !hashesEqual(row.codeHash, codeHash)) {
    throw new McpOAuthError("invalid_grant", "Authorization code is invalid or expired.", 400);
  }
  if (row.redirectUri !== input.redirectUri) {
    throw new McpOAuthError("invalid_grant", "redirect_uri does not match authorization code.");
  }
  if (normalizeResource(input.resource ?? row.resource) !== row.resource) {
    throw new McpOAuthError("invalid_target", "resource does not match authorization code.");
  }
  if (row.codeChallenge !== pkceS256(input.codeVerifier)) {
    throw new McpOAuthError("invalid_grant", "PKCE verification failed.");
  }

  const [usedCode] = await getDb()
    .update(personalMcpOAuthAuthorizationCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(personalMcpOAuthAuthorizationCodes.codeHash, row.codeHash),
        isNull(personalMcpOAuthAuthorizationCodes.usedAt),
      ),
    )
    .returning({ codeHash: personalMcpOAuthAuthorizationCodes.codeHash });

  if (!usedCode) {
    throw new McpOAuthError("invalid_grant", "Authorization code has already been used.");
  }

  return createTokenPair({
    clientId: row.clientId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    scope: row.scope,
    resource: row.resource,
  });
}

export async function refreshPersonalMcpAccessToken(input: {
  refreshToken: string;
  clientId: string;
  resource?: string | null;
}) {
  const now = new Date();
  const refreshTokenHash = hashSecret(input.refreshToken);
  const [row] = await getDb()
    .select()
    .from(personalMcpOAuthTokens)
    .where(
      and(
        eq(personalMcpOAuthTokens.refreshTokenHash, refreshTokenHash),
        eq(personalMcpOAuthTokens.clientId, input.clientId),
        gt(personalMcpOAuthTokens.refreshTokenExpiresAt, now),
        isNull(personalMcpOAuthTokens.revokedAt),
      ),
    )
    .limit(1);

  if (!row || !row.refreshTokenHash || !hashesEqual(row.refreshTokenHash, refreshTokenHash)) {
    throw new McpOAuthError("invalid_grant", "Refresh token is invalid or expired.");
  }
  if (normalizeResource(input.resource ?? row.resource) !== row.resource) {
    throw new McpOAuthError("invalid_target", "resource does not match refresh token.");
  }

  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const [rotatedToken] = await getDb()
    .update(personalMcpOAuthTokens)
    .set({
      accessTokenHash: hashSecret(accessToken),
      refreshTokenHash: hashSecret(refreshToken),
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(personalMcpOAuthTokens.id, row.id),
        eq(personalMcpOAuthTokens.refreshTokenHash, refreshTokenHash),
        isNull(personalMcpOAuthTokens.revokedAt),
      ),
    )
    .returning({ id: personalMcpOAuthTokens.id });

  if (!rotatedToken) {
    throw new McpOAuthError("invalid_grant", "Refresh token has already been used.");
  }

  return tokenResponse({
    accessToken,
    refreshToken,
    scope: row.scope,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export async function authenticatePersonalMcpOAuthAccessToken(
  authorizationHeader: string | null,
): Promise<PersonalMcpOAuthAuth | null> {
  const token = readBearerToken(authorizationHeader);
  if (!token) return null;

  const tokenHash = hashSecret(token);
  const [row] = await getDb()
    .select({
      id: personalMcpOAuthTokens.id,
      accessTokenHash: personalMcpOAuthTokens.accessTokenHash,
      clientId: personalMcpOAuthTokens.clientId,
      workspaceId: personalMcpOAuthTokens.workspaceId,
      userId: personalMcpOAuthTokens.userId,
      scope: personalMcpOAuthTokens.scope,
      resource: personalMcpOAuthTokens.resource,
    })
    .from(personalMcpOAuthTokens)
    .where(
      and(
        eq(personalMcpOAuthTokens.accessTokenHash, tokenHash),
        gt(personalMcpOAuthTokens.accessTokenExpiresAt, new Date()),
        isNull(personalMcpOAuthTokens.revokedAt),
      ),
    )
    .limit(1);

  if (
    !row ||
    !hashesEqual(row.accessTokenHash, tokenHash) ||
    row.resource !== openCompanyMcpResource() ||
    !row.scope.split(/\s+/).includes(OPENCOMPANY_MCP_SCOPE)
  ) {
    return null;
  }

  await getDb()
    .update(personalMcpOAuthTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalMcpOAuthTokens.id, row.id));

  return {
    tokenId: row.id,
    clientId: row.clientId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    scope: row.scope,
  };
}

export function readBearerToken(header: string | null) {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function createTokenPair(input: {
  clientId: string;
  workspaceId: string;
  userId: string;
  scope: string;
  resource: string;
}) {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  const now = new Date();
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  return getDb()
    .insert(personalMcpOAuthTokens)
    .values({
      id: newId("pmcpot"),
      accessTokenHash: hashSecret(accessToken),
      refreshTokenHash: hashSecret(refreshToken),
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      scope: input.scope,
      resource: input.resource,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      updatedAt: now,
    })
    .then(() =>
      tokenResponse({
        accessToken,
        refreshToken,
        scope: input.scope,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      }),
    );
}

function tokenResponse(input: {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresIn: number;
}) {
  return {
    access_token: input.accessToken,
    token_type: "Bearer",
    expires_in: input.expiresIn,
    refresh_token: input.refreshToken,
    scope: input.scope,
  };
}

async function findClient(clientId: string) {
  const [client] = await getDb()
    .select()
    .from(personalMcpOAuthClients)
    .where(eq(personalMcpOAuthClients.clientId, clientId))
    .limit(1);
  return client ?? null;
}

function requiredParam(url: URL, key: string) {
  const value = url.searchParams.get(key)?.trim();
  if (!value) throw new McpOAuthError("invalid_request", `${key} is required.`);
  return value;
}

function normalizeRedirectUris(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new McpOAuthError("invalid_redirect_uri", "redirect_uris must contain at least one URI.");
  }

  const uris = [...new Set(value.filter((uri): uri is string => typeof uri === "string"))];
  if (uris.length === 0 || uris.length > 20) {
    throw new McpOAuthError("invalid_redirect_uri", "redirect_uris must contain 1-20 URIs.");
  }

  for (const uri of uris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new McpOAuthError("invalid_redirect_uri", `redirect_uri is not allowed: ${uri}`);
    }
  }
  return uris;
}

function isAllowedRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return fallback;
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return values.length ? [...new Set(values)] : fallback;
}

function normalizeString(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function normalizeOptionalUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeScope(value: string | undefined | null) {
  const requested = value?.split(/\s+/).filter(Boolean) ?? [];
  const accepted = requested.filter(
    (scope) => scope === OPENCOMPANY_MCP_SCOPE || OPTIONAL_IDENTITY_SCOPES.has(scope),
  );
  if (!accepted.includes(OPENCOMPANY_MCP_SCOPE)) accepted.push(OPENCOMPANY_MCP_SCOPE);
  return [...new Set(accepted)].join(" ");
}

function normalizeResource(value: string | null | undefined) {
  const expected = openCompanyMcpResource();
  if (!value) return expected;
  if (value !== expected) {
    throw new McpOAuthError("invalid_target", "resource must match the OpenCompany MCP endpoint.");
  }
  return value;
}

function pkceS256(codeVerifier: string) {
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

function hashSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function clientRegistrationResponse(row: typeof personalMcpOAuthClients.$inferSelect) {
  return {
    client_id: row.clientId,
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    client_name: row.clientName,
    ...(row.clientUri ? { client_uri: row.clientUri } : {}),
    ...(row.logoUri ? { logo_uri: row.logoUri } : {}),
    redirect_uris: row.redirectUris,
    grant_types: row.grantTypes,
    response_types: row.responseTypes,
    scope: row.scope,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
  };
}

function newId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
