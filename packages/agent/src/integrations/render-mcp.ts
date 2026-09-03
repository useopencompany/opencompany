import { getDb } from "@opencompany/db/client";
import {
  loadIntegrationCredential,
  markIntegrationStatus,
  saveIntegrationCredential,
} from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { captureIntegrationAddedAnalytics } from "./analytics";
import type { RemoteMcpProviderState } from "./remote-mcp-oauth";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const RENDER_MCP_ENDPOINT_URL = "https://mcp.render.com/mcp";
export const RENDER_API_BASE_URL = "https://api.render.com/v1";
const RENDER_MCP_EXTERNAL_ID = "render_mcp_api_key";
const RENDER_CREDENTIAL_KIND = "api_key" as const;

type DbLike = any;

type RenderOwner = {
  id: string;
  name: string;
  email: string | null;
};

export type RenderProviderState = RemoteMcpProviderState<"render">;

export function isValidRenderApiKey(value: string) {
  return /^rnd_[A-Za-z0-9_-]{8,}$/u.test(value);
}

export async function validateRenderApiKey(
  apiKey: string,
  dependencies: { fetch?: typeof fetch } = {},
): Promise<{ ok: true; owner: RenderOwner | null } | { ok: false; error: string }> {
  const fetchImpl = dependencies.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${RENDER_API_BASE_URL}/owners?limit=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: "Render could not be reached. Try again in a moment." };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "Render rejected this API key. Check it and try again." };
  }
  if (!response.ok) {
    return { ok: false, error: "Render could not validate this API key. Try again in a moment." };
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(payload)) {
    return { ok: false, error: "Render returned an unexpected response while validating the key." };
  }
  const owner = parseOwner(payload[0]);
  if (payload.length > 0 && !owner) {
    return { ok: false, error: "Render returned an unexpected response while validating the key." };
  }
  return { ok: true, owner };
}

export async function connectRenderMcpIntegration(input: {
  userWorkosId: string;
  apiKey: string;
  owner: RenderOwner | null;
  db?: DbLike;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const accountName = input.owner?.name ?? "Render";
  const [integration] = await db
    .insert(integrations)
    .values({
      id: `gint_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      userWorkosId: input.userWorkosId,
      provider: "render",
      externalId: RENDER_MCP_EXTERNAL_ID,
      connectionLabel: accountName,
      accountName,
      accountEmail: input.owner?.email ?? null,
      accountType: "render_api_key",
      status: "connected",
      statusReason: null,
      scopes: [],
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
      set: {
        connectionLabel: accountName,
        accountName,
        accountEmail: input.owner?.email ?? null,
        accountType: "render_api_key",
        status: "connected",
        statusReason: null,
        scopes: [],
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });
  if (!integration) throw new Error("Could not persist the Render integration.");

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "render",
      kind: RENDER_CREDENTIAL_KIND,
      payload: { apiKey: input.apiKey },
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "render",
      status: "sync_failed",
      statusReason: "Failed to store the Render API key securely.",
      db,
      now: new Date(),
    });
    throw error;
  }

  await captureIntegrationAddedAnalytics({ userWorkosId: input.userWorkosId, provider: "render" });
  return { integrationId: integration.id };
}

export async function getRenderIntegrationState(
  identity: string | { userWorkosId: string; workspaceId?: string },
  db: DbLike = getDb(),
): Promise<RenderProviderState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadRenderIntegration(db, userWorkosId);
  if (!row || row.status === "disconnected") {
    return {
      provider: "render",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
      capabilityModes: {},
      toolModes: {},
    };
  }
  return {
    provider: "render",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    statusReason: row.statusReason,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadRenderMcpWorkerConnection(input: {
  userWorkosId: string;
  workspaceId?: string;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadRenderIntegration(getDb(), input.userWorkosId);
  if (!row || row.status === "disconnected")
    return { ok: false as const, reason: "not_connected" as const };
  if (row.status !== "connected") return { ok: false as const, reason: "needs_reauth" as const };

  const credential = await loadIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: row.id,
    provider: "render",
    kind: RENDER_CREDENTIAL_KIND,
  });
  const apiKey = credential?.payload.apiKey;
  if (typeof apiKey !== "string" || !isValidRenderApiKey(apiKey)) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: row.id,
      provider: "render",
      status: "needs_reauth",
      statusReason: "Render needs to be reconnected before opencompany can use it.",
    });
    return { ok: false as const, reason: "needs_reauth" as const };
  }

  return {
    ok: true as const,
    integrationId: row.id,
    authProvider: createRemoteMcpStaticBearerAuthProvider({
      accessToken: apiKey,
      onAuthorizationRequired: async () => {
        await markIntegrationStatus({
          userWorkosId: input.userWorkosId,
          integrationId: row.id,
          provider: "render",
          status: "needs_reauth",
          statusReason: "Render rejected the saved API key. Reconnect Render in Settings.",
        });
        return input.onAuthorizationRequired();
      },
    }),
  };
}

async function loadRenderIntegration(db: DbLike, userWorkosId: string) {
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      accountName: integrations.accountName,
      statusReason: integrations.statusReason,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, "render"),
        eq(integrations.externalId, RENDER_MCP_EXTERNAL_ID),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row;
}

function parseOwner(value: unknown): RenderOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = (value as { owner?: unknown }).owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
  const record = owner as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string") return null;
  return {
    id: record.id,
    name: record.name,
    email: typeof record.email === "string" ? record.email : null,
  };
}
