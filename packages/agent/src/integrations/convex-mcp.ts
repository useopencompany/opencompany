import { getDb } from "@opencompany/db/client";
import {
  loadIntegrationCredential,
  markIntegrationStatus,
  saveIntegrationCredential,
} from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { RemoteMcpOperation } from "../actions/remote-mcp";
import { captureConnectionAddedAnalytics } from "./analytics";
import { runConvexCli } from "./convex-cli";
import { convexCredentialVersion, createConvexMcpTicket } from "./convex-mcp-ticket";
import { parseConvexDeployKey } from "./convex-policy";
import type { RemoteMcpProviderState } from "./remote-mcp-oauth";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export const CONVEX_MCP_ENDPOINT_URL = "https://api.opencompany.chat/mcp/plugins/convex";
const CONVEX_MCP_EXTERNAL_ID = "convex_mcp_api_key";
const CONVEX_CREDENTIAL_KIND = "api_key" as const;

type DbLike = any;

export type ConvexProviderState = RemoteMcpProviderState<"convex">;

export function convexMcpRuntimeEndpointUrl() {
  const origin = process.env.OPENCOMPANY_API_ORIGIN?.trim();
  if (!origin) return CONVEX_MCP_ENDPOINT_URL;
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Convex MCP requires a trusted HTTPS API origin.");
  }
  return new URL("/mcp/plugins/convex", url).toString();
}

export async function validateConvexApiKey(
  apiKey: string,
): Promise<{ ok: true; deployment: string } | { ok: false; error: string }> {
  const deployment = parseConvexDeployKey(apiKey);
  if (!deployment)
    return { ok: false, error: "Use a deployment-scoped Convex key starting with dev: or prod:." };
  try {
    const result = await runConvexCli({ apiKey, tool: "functionSpec", args: {} });
    if (result.isError)
      return {
        ok: false,
        error:
          "Convex rejected the key or its permissions. Enable function inspection and try again.",
      };
    return { ok: true, deployment: deployment.name };
  } catch {
    return {
      ok: false,
      error: "Convex could not validate this deploy key. Check it and try again.",
    };
  }
}

export async function connectConvexMcpIntegration(input: {
  userWorkosId: string;
  apiKey: string;
  deployment: string;
  db?: DbLike;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const accountName = input.deployment;
  const [integration] = await db
    .insert(integrations)
    .values({
      id: `gint_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      userWorkosId: input.userWorkosId,
      provider: "convex",
      externalId: CONVEX_MCP_EXTERNAL_ID,
      connectionLabel: accountName,
      accountName,
      accountEmail: null,
      accountType: "convex_api_key",
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
        capabilityModes: sql`CASE WHEN ${integrations.accountName} = ${accountName} THEN ${integrations.capabilityModes} ELSE '{}'::jsonb END`,
        toolModes: sql`CASE WHEN ${integrations.accountName} = ${accountName} THEN ${integrations.toolModes} ELSE '{}'::jsonb END`,
        connectionLabel: accountName,
        accountName,
        accountEmail: null,
        accountType: "convex_api_key",
        status: "connected",
        statusReason: null,
        scopes: [],
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });
  if (!integration) throw new Error("Could not persist the Convex integration.");

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "convex",
      kind: CONVEX_CREDENTIAL_KIND,
      payload: { apiKey: input.apiKey },
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: "convex",
      status: "sync_failed",
      statusReason: "Failed to store the Convex API key securely.",
      db,
      now: new Date(),
    });
    throw error;
  }

  await captureConnectionAddedAnalytics({
    connectionId: integration.id,
    userWorkosId: input.userWorkosId,
    provider: "convex",
  });
  return { integrationId: integration.id };
}

export async function getConvexIntegrationState(
  identity: string | { userWorkosId: string; workspaceId?: string },
  db: DbLike = getDb(),
): Promise<ConvexProviderState> {
  const userWorkosId = typeof identity === "string" ? identity : identity.userWorkosId;
  const row = await loadConvexIntegration(db, userWorkosId);
  if (!row || row.status === "disconnected") {
    return {
      provider: "convex",
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
    provider: "convex",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    statusReason: row.statusReason,
    capabilityModes: row.capabilityModes,
    toolModes: row.toolModes,
  };
}

export async function loadConvexMcpWorkerConnection(input: {
  userWorkosId: string;
  workspaceId: string;
  registrationId: string;
  operation: RemoteMcpOperation;
  onAuthorizationRequired: () => never;
}) {
  const row = await loadConvexIntegration(getDb(), input.userWorkosId);
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected") return { ok: false, reason: "needs_reauth" } as const;
  const apiKey = await loadConvexCredential(input.userWorkosId, row.id, getDb());
  if (!apiKey) return { ok: false, reason: "needs_reauth" } as const;
  const secret = process.env.API_INTERNAL_TOKEN?.trim();
  if (!secret) throw new Error("Convex MCP requires API_INTERNAL_TOKEN.");
  const { ticket } = createConvexMcpTicket({
    ...input,
    integrationId: row.id,
    connectionVersion: convexCredentialVersion(apiKey),
    secret,
  });
  return {
    ok: true,
    integrationId: row.id,
    authProvider: createRemoteMcpStaticBearerAuthProvider({
      accessToken: ticket,
      onAuthorizationRequired: async () => input.onAuthorizationRequired(),
    }),
  } as const;
}

export async function loadConvexCredential(
  userWorkosId: string,
  integrationId: string,
  db: DbLike,
) {
  const credential = await loadIntegrationCredential({
    userWorkosId,
    integrationId,
    provider: "convex",
    kind: CONVEX_CREDENTIAL_KIND,
    db,
  });
  const apiKey = credential?.payload.apiKey;
  return typeof apiKey === "string" && parseConvexDeployKey(apiKey) ? apiKey : null;
}

export async function loadConvexIntegration(db: DbLike, userWorkosId: string) {
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
        eq(integrations.provider, "convex"),
        eq(integrations.externalId, CONVEX_MCP_EXTERNAL_ID),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row;
}
