import { getDb } from "@opencompany/db/client";
import type { WorkspaceIntegration } from "@opencompany/db/schema";
import { workspaceMcpServers } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import {
  loadIntegrationCredential,
  markIntegrationCredentialRefreshFailed,
  refreshIntegrationCredential,
} from "@/lib/integrations/credential-storage";
import { loadMcpCredential } from "@/lib/mcp/credential-storage";
import { POSTHOG_MCP_OAUTH_CREDENTIAL_KIND, POSTHOG_MCP_SERVER_KEY } from "@/lib/mcp/data";
import { posthogMcpOAuth } from "@/lib/mcp/oauth-providers";

export const POSTHOG_KPI_PROVIDER = "posthog";
export const POSTHOG_KPI_CREDENTIAL_KIND = "oauth_token";
export const DEFAULT_POSTHOG_API_HOST = "https://us.posthog.com";
export const POSTHOG_QUERY_TIMEOUT_MS = 8_000;

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export type PostHogQueryResult = {
  results?: unknown[][];
  is_cached?: boolean;
  timings?: unknown;
};

export type PostHogMetricWindow = {
  start: Date;
  end: Date;
};

export type PostHogMetricFetchResult = {
  value: number;
  source: {
    provider: typeof POSTHOG_KPI_PROVIDER;
    queryName: string;
    projectId: string;
    status: number;
    isCached: boolean | null;
    durationMs: number;
    window: { start: string; end: string };
  };
};

export class PostHogAuthenticationError extends Error {
  constructor(message = "PostHog connection needs reauthorization.") {
    super(message);
    this.name = "PostHogAuthenticationError";
  }
}

export async function fetchPostHogDistinctUsers(input: {
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >;
  window: PostHogMetricWindow;
  fetchFn?: typeof fetch;
}): Promise<PostHogMetricFetchResult> {
  return fetchPostHogCount({
    integration: input.integration,
    window: input.window,
    query: `
      SELECT count(DISTINCT distinct_id)
      FROM events
      WHERE timestamp >= ${hogqlDate(input.window.start)}
        AND timestamp < ${hogqlDate(input.window.end)}
      LIMIT 1
    `,
    queryName: "opencompany_kpi_distinct_users",
    ...fetchOption(input.fetchFn),
  });
}

export async function fetchPostHogEventCount(input: {
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >;
  window: PostHogMetricWindow;
  eventNames: string[];
  fetchFn?: typeof fetch;
}): Promise<PostHogMetricFetchResult> {
  const names = input.eventNames.map(hogqlString).join(", ");
  return fetchPostHogCount({
    integration: input.integration,
    window: input.window,
    query: `
      SELECT count()
      FROM events
      WHERE timestamp >= ${hogqlDate(input.window.start)}
        AND timestamp < ${hogqlDate(input.window.end)}
        AND event IN (${names})
      LIMIT 1
    `,
    queryName: "opencompany_kpi_event_count",
    ...fetchOption(input.fetchFn),
  });
}

async function fetchPostHogCount(input: {
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >;
  window: PostHogMetricWindow;
  query: string;
  queryName: string;
  fetchFn?: typeof fetch;
}): Promise<PostHogMetricFetchResult> {
  const accessToken = await loadFreshPostHogAccessToken({
    integration: input.integration,
    now: new Date(),
  });

  const apiHost = readPostHogApiHost(input.integration.metadata);
  const endpoint = `${apiHost}/api/projects/${encodeURIComponent(input.integration.externalId)}/query/`;
  const startedAt = Date.now();
  const response = await fetchPostHogQuery(input.fetchFn ?? fetch, endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: compactQuery(input.query),
      },
      name: input.queryName,
      refresh: "blocking",
    }),
  });

  if (response.status === 401) {
    const refreshedAccessToken = await loadFreshPostHogAccessToken({
      integration: input.integration,
      now: new Date(),
      forceSyncFromMcp: true,
      previousAccessToken: accessToken,
    });
    const retryStartedAt = Date.now();
    const retryResponse = await fetchPostHogQuery(input.fetchFn ?? fetch, endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${refreshedAccessToken}`,
      },
      body: JSON.stringify({
        query: {
          kind: "HogQLQuery",
          query: compactQuery(input.query),
        },
        name: input.queryName,
        refresh: "blocking",
      }),
    });
    if (retryResponse.status === 401) {
      await markPostHogNeedsReauth(input.integration);
      throw new PostHogAuthenticationError();
    }
    if (retryResponse.status === 403) {
      await markPostHogPermissionFailed(input.integration);
      throw new PostHogAuthenticationError(
        "PostHog connection lacks required query permission. Reconnect PostHog to resume KPI updates.",
      );
    }
    return readPostHogCountResponse({
      response: retryResponse,
      durationMs: Date.now() - retryStartedAt,
      integration: input.integration,
      queryName: input.queryName,
      window: input.window,
    });
  }

  if (response.status === 403) {
    await markPostHogPermissionFailed(input.integration);
    throw new PostHogAuthenticationError(
      "PostHog connection lacks required query permission. Reconnect PostHog to resume KPI updates.",
    );
  }

  return readPostHogCountResponse({
    response,
    durationMs: Date.now() - startedAt,
    integration: input.integration,
    queryName: input.queryName,
    window: input.window,
  });
}

async function readPostHogCountResponse(input: {
  response: Response;
  durationMs: number;
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >;
  queryName: string;
  window: PostHogMetricWindow;
}): Promise<PostHogMetricFetchResult> {
  const { response } = input;
  if (!response.ok) {
    throw new Error(`PostHog Query API returned ${response.status}.`);
  }

  const body = (await response.json()) as PostHogQueryResult;
  return {
    value: readFirstNumber(body),
    source: {
      provider: POSTHOG_KPI_PROVIDER,
      queryName: input.queryName,
      projectId: input.integration.externalId,
      status: response.status,
      isCached: typeof body.is_cached === "boolean" ? body.is_cached : null,
      durationMs: input.durationMs,
      window: {
        start: input.window.start.toISOString(),
        end: input.window.end.toISOString(),
      },
    },
  };
}

async function fetchPostHogQuery(fetchFn: typeof fetch, endpoint: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POSTHOG_QUERY_TIMEOUT_MS);
  try {
    return await fetchFn(endpoint, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`PostHog Query API timed out after ${POSTHOG_QUERY_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadFreshPostHogAccessToken(input: {
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >;
  now: Date;
  forceSyncFromMcp?: boolean;
  previousAccessToken?: string;
}) {
  const credential = await loadIntegrationCredential({
    workspaceId: input.integration.workspaceId,
    integrationId: input.integration.id,
    provider: POSTHOG_KPI_PROVIDER,
    kind: POSTHOG_KPI_CREDENTIAL_KIND,
  });
  const mirroredAccessToken = readTokenString(credential?.payload, "accessToken");
  const mirroredIsFresh =
    mirroredAccessToken &&
    (!credential?.expiresAt ||
      credential.expiresAt.getTime() - input.now.getTime() > TOKEN_REFRESH_SKEW_MS);
  if (!input.forceSyncFromMcp && mirroredIsFresh) return mirroredAccessToken;

  const synced = await syncPostHogCredentialFromMcp(input.integration, input.now);
  if (synced?.accessToken && synced.accessToken !== input.previousAccessToken) {
    return synced.accessToken;
  }
  if (!input.forceSyncFromMcp && mirroredAccessToken && !credential?.expiresAt) {
    return mirroredAccessToken;
  }

  await markPostHogNeedsReauth(input.integration);
  throw new PostHogAuthenticationError();
}

async function syncPostHogCredentialFromMcp(
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >,
  now: Date,
) {
  const [server] = await getDb()
    .select({ id: workspaceMcpServers.id })
    .from(workspaceMcpServers)
    .where(
      and(
        eq(workspaceMcpServers.workspaceId, integration.workspaceId),
        eq(workspaceMcpServers.serverKey, POSTHOG_MCP_SERVER_KEY),
      ),
    )
    .limit(1);
  if (!server) return null;

  const credential = await loadMcpCredential({
    workspaceId: integration.workspaceId,
    serverId: server.id,
    kind: POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
  });
  if (!credential) return null;
  let tokens = credential.payload.tokens;
  let accessToken = readTokenString(tokens, "access_token");
  if (!accessToken) return null;

  let expiresAt = credential.expiresAt ?? readTokenExpiresAt(tokens, now);
  if (expiresAt && expiresAt.getTime() - now.getTime() <= TOKEN_REFRESH_SKEW_MS) {
    if (!readTokenString(tokens, "refresh_token")) return null;
    try {
      const refreshed = await posthogMcpOAuth.refreshTokens({
        workspaceId: integration.workspaceId,
        serverId: server.id,
      });
      tokens = refreshed.payload.tokens;
      expiresAt = refreshed.expiresAt ?? readTokenExpiresAt(tokens, now);
    } catch {
      return null;
    }
    accessToken = readTokenString(tokens, "access_token");
    if (!accessToken) return null;
    if (expiresAt && expiresAt.getTime() - now.getTime() <= TOKEN_REFRESH_SKEW_MS) return null;
  }

  await refreshIntegrationCredential({
    workspaceId: integration.workspaceId,
    integrationId: integration.id,
    provider: POSTHOG_KPI_PROVIDER,
    kind: POSTHOG_KPI_CREDENTIAL_KIND,
    payload: {
      accessToken,
      tokenType: readTokenString(tokens, "token_type"),
      refreshToken: readTokenString(tokens, "refresh_token"),
      scope: readTokenString(tokens, "scope"),
    },
    expiresAt,
    now,
  });
  return { accessToken, expiresAt };
}

async function markPostHogNeedsReauth(
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >,
) {
  await markIntegrationCredentialRefreshFailed({
    workspaceId: integration.workspaceId,
    integrationId: integration.id,
    provider: POSTHOG_KPI_PROVIDER,
    status: "needs_reauth",
    statusReason: "PostHog authorization expired. Reconnect PostHog to resume KPI updates.",
  });
}

async function markPostHogPermissionFailed(
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >,
) {
  await markIntegrationCredentialRefreshFailed({
    workspaceId: integration.workspaceId,
    integrationId: integration.id,
    provider: POSTHOG_KPI_PROVIDER,
    status: "sync_failed",
    statusReason:
      "PostHog query permission is missing. Reconnect PostHog with query:read access to resume KPI updates.",
  });
}

export function readPostHogApiHost(metadata: Record<string, unknown>) {
  const value = typeof metadata.apiHost === "string" ? metadata.apiHost.trim() : "";
  if (!value) return DEFAULT_POSTHOG_API_HOST;
  return value.replace(/\/+$/, "");
}

export function parsePostHogEventNames(value: unknown, fallback: string[]) {
  if (Array.isArray(value)) {
    const names = value.filter((item): item is string => typeof item === "string");
    return normalizeEventNames(names, fallback);
  }
  if (typeof value === "string") {
    return normalizeEventNames(value.split(","), fallback);
  }
  return fallback;
}

function normalizeEventNames(value: string[], fallback: string[]) {
  const names = value.map((item) => item.trim()).filter(Boolean);
  return names.length > 0 ? names.slice(0, 10) : fallback;
}

function readFirstNumber(body: PostHogQueryResult) {
  const first = body.results?.[0]?.[0];
  if (typeof first === "number" && Number.isFinite(first)) return first;
  if (typeof first === "string") {
    const parsed = Number(first);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function hogqlDate(date: Date) {
  return hogqlString(date.toISOString());
}

function hogqlString(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function readTokenString(tokens: unknown, key: string) {
  if (!tokens || typeof tokens !== "object" || !(key in tokens)) return undefined;
  const value = (tokens as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readTokenExpiresAt(tokens: unknown, now: Date) {
  if (!tokens || typeof tokens !== "object") return null;
  const expiresAt = (tokens as Record<string, unknown>).expires_at;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return new Date(expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt);
  }
  const expiresIn = (tokens as Record<string, unknown>).expires_in;
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? new Date(now.getTime() + expiresIn * 1000)
    : null;
}

function compactQuery(query: string) {
  return query
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function fetchOption(fetchFn: typeof fetch | undefined) {
  return fetchFn ? { fetchFn } : {};
}
