import { getDb } from "@opencompany/db/client";
import { workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { saveIntegrationCredential } from "@/lib/integrations/credential-storage";
import {
  DEFAULT_POSTHOG_API_HOST,
  POSTHOG_KPI_CREDENTIAL_KIND,
  POSTHOG_KPI_PROVIDER,
} from "@/lib/kpis/posthog";
import { loadMcpCredential } from "@/lib/mcp/credential-storage";
import { POSTHOG_MCP_OAUTH_CREDENTIAL_KIND } from "@/lib/mcp/data";

const POSTHOG_API_HOSTS = [DEFAULT_POSTHOG_API_HOST, "https://eu.posthog.com"] as const;

type PostHogMe = {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  team?: {
    id?: number | string | null;
    project_id?: number | string | null;
    name?: string | null;
    organization?: string | null;
  } | null;
  organization?: {
    id?: string | null;
    name?: string | null;
    slug?: string | null;
  } | null;
};

export async function syncPostHogDataSourceFromMcpOAuth(input: {
  workspaceId: string;
  userId: string;
  serverId: string;
  fetchFn?: typeof fetch;
}) {
  const credential = await loadMcpCredential({
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    kind: POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
  });
  const tokens = credential?.payload.tokens;
  const accessToken =
    tokens &&
    typeof tokens === "object" &&
    "access_token" in tokens &&
    typeof tokens.access_token === "string"
      ? tokens.access_token
      : "";
  if (!accessToken) throw new Error("PostHog OAuth token is missing.");

  const profile = await discoverPostHogProfile(accessToken, input.fetchFn);
  const now = new Date();
  const projectId = String(profile.me.team?.project_id ?? profile.me.team?.id ?? "").trim();
  if (!projectId) throw new Error("PostHog OAuth profile did not include a project id.");

  const organizationLabel =
    profile.me.organization?.name ?? profile.me.organization?.slug ?? profile.me.team?.organization;
  const projectName = profile.me.team?.name ?? `Project ${projectId}`;
  const connectionLabel = organizationLabel ? `${organizationLabel} / ${projectName}` : projectName;

  const [integration] = await getDb()
    .insert(workspaceIntegrations)
    .values({
      id: newWorkspaceIntegrationId(),
      workspaceId: input.workspaceId,
      provider: POSTHOG_KPI_PROVIDER,
      providerKind: "data_source",
      externalId: projectId,
      connectionLabel,
      accountName: projectName,
      accountEmail: profile.me.email ?? null,
      accountType: "Project",
      connectedByUserId: input.userId,
      status: "connected",
      statusReason: null,
      lastSyncedAt: now,
      scopes: readTokenScopes(tokens),
      metadata: {
        apiHost: profile.apiHost,
        organizationId: profile.me.organization?.id ?? profile.me.team?.organization ?? null,
        organizationName: organizationLabel ?? null,
        projectId,
        projectName,
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workspaceIntegrations.workspaceId,
        workspaceIntegrations.provider,
        workspaceIntegrations.externalId,
      ],
      set: {
        providerKind: "data_source",
        connectionLabel,
        accountName: projectName,
        accountEmail: profile.me.email ?? null,
        accountType: "Project",
        connectedByUserId: input.userId,
        status: "connected",
        statusReason: null,
        lastSyncedAt: now,
        scopes: readTokenScopes(tokens),
        metadata: sql`excluded.metadata`,
        updatedAt: now,
      },
    })
    .returning({ id: workspaceIntegrations.id });

  if (!integration) throw new Error("Could not persist PostHog data-source integration.");

  await saveIntegrationCredential({
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    provider: POSTHOG_KPI_PROVIDER,
    kind: POSTHOG_KPI_CREDENTIAL_KIND,
    payload: {
      accessToken,
      tokenType: readTokenString(tokens, "token_type"),
      refreshToken: readTokenString(tokens, "refresh_token"),
      scope: readTokenString(tokens, "scope"),
    },
    expiresAt: readTokenExpiresAt(tokens, now),
    db: getDb(),
    now,
  });

  return integration;
}

export async function deletePostHogDataSourcesForWorkspace(workspaceId: string) {
  await getDb()
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, POSTHOG_KPI_PROVIDER),
        eq(workspaceIntegrations.providerKind, "data_source"),
      ),
    );
}

export async function discoverPostHogProfile(accessToken: string, fetchFn: typeof fetch = fetch) {
  let lastError: Error | null = null;
  for (const apiHost of POSTHOG_API_HOSTS) {
    try {
      const response = await fetchFn(`${apiHost}/api/users/@me/`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error(`PostHog profile returned ${response.status}.`);
      return { apiHost, me: (await response.json()) as PostHogMe };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("PostHog profile fetch failed.");
    }
  }
  throw lastError ?? new Error("PostHog profile fetch failed.");
}

function readTokenString(tokens: unknown, key: string) {
  if (!tokens || typeof tokens !== "object" || !(key in tokens)) return undefined;
  const value = (tokens as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readTokenScopes(tokens: unknown) {
  return (readTokenString(tokens, "scope") ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function readTokenExpiresAt(tokens: unknown, now: Date) {
  if (!tokens || typeof tokens !== "object" || !("expires_in" in tokens)) return null;
  const expiresIn = (tokens as Record<string, unknown>).expires_in;
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? new Date(now.getTime() + expiresIn * 1000)
    : null;
}

function newWorkspaceIntegrationId() {
  return `wint_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
