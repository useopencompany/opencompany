"use server";

import { getDb } from "@opencompany/db/client";
import { workspaceMcpServers } from "@opencompany/db/schema";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import { deleteMcpCredential, saveMcpCredential } from "@/lib/mcp/credential-storage";
import {
  BETTERSTACK_MCP_ENDPOINT_URL,
  BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND,
  BETTERSTACK_MCP_SERVER_KEY,
  LINEAR_MCP_ENDPOINT_URL,
  LINEAR_MCP_SERVER_KEY,
  type McpProviderKey,
  POSTHOG_MCP_ENDPOINT_URL,
  POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
  POSTHOG_MCP_SERVER_KEY,
  SLACK_MCP_ENDPOINT_URL,
  SLACK_MCP_OAUTH_CREDENTIAL_KIND,
  SLACK_MCP_SERVER_KEY,
} from "@/lib/mcp/data";
import { linearMcpOAuthCredentialKind } from "@/lib/mcp/linear-oauth";

export async function saveLinearMcpToken(token: string) {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const bearerToken = token.trim();
  if (!bearerToken) return { ok: false as const, error: "Linear token is required." };
  if (bearerToken.length > 4096) return { ok: false as const, error: "Linear token is too long." };

  const server = await upsertLinearMcpServer(workspace.id, "configured", null);
  await saveMcpCredential({
    workspaceId: workspace.id,
    serverId: server.id,
    kind: "bearer_token",
    bearerToken,
  });
  await deleteMcpCredential({
    workspaceId: workspace.id,
    serverId: server.id,
    kind: linearMcpOAuthCredentialKind(),
  });

  revalidateMcpPaths();
  return { ok: true as const };
}

export async function removeLinearMcpToken() {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const server = await upsertLinearMcpServer(
    workspace.id,
    "missing_credential",
    "Linear MCP token was removed.",
  );
  await deleteMcpCredential({
    workspaceId: workspace.id,
    serverId: server.id,
    kind: "bearer_token",
  });
  await deleteMcpCredential({
    workspaceId: workspace.id,
    serverId: server.id,
    kind: linearMcpOAuthCredentialKind(),
  });

  revalidateMcpPaths();
  return { ok: true as const };
}

export async function removeSlackMcpConnection() {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const server = await upsertSlackMcpServer(
    workspace.id,
    "missing_credential",
    "Slack MCP connection was removed.",
  );
  await deleteMcpCredential({
    workspaceId: workspace.id,
    serverId: server.id,
    kind: SLACK_MCP_OAUTH_CREDENTIAL_KIND,
  });

  revalidateMcpPaths();
  return { ok: true as const };
}

export async function removePostHogMcpConnection() {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const server = await upsertPostHogMcpServer(
    workspace.id,
    "missing_credential",
    "PostHog MCP connection was removed.",
  );
  await deleteMcpCredential({
    workspaceId: workspace.id,
    serverId: server.id,
    kind: POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
  });

  revalidateMcpPaths();
  return { ok: true as const };
}

export async function removeBetterStackMcpConnection() {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const server = await upsertBetterStackMcpServer(
    workspace.id,
    "missing_credential",
    "Better Stack MCP connection was removed.",
  );
  await deleteMcpCredential({
    workspaceId: workspace.id,
    serverId: server.id,
    kind: BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND,
  });

  revalidateMcpPaths();
  return { ok: true as const };
}

export async function upsertLinearMcpServer(
  workspaceId: string,
  status: "configured" | "missing_credential" | "error",
  statusReason: string | null,
) {
  return upsertMcpServer({
    workspaceId,
    serverKey: LINEAR_MCP_SERVER_KEY,
    displayName: "Linear",
    endpointUrl: LINEAR_MCP_ENDPOINT_URL,
    status,
    statusReason,
  });
}

export async function upsertSlackMcpServer(
  workspaceId: string,
  status: "configured" | "missing_credential" | "error",
  statusReason: string | null,
) {
  return upsertMcpServer({
    workspaceId,
    serverKey: SLACK_MCP_SERVER_KEY,
    displayName: "Slack",
    endpointUrl: SLACK_MCP_ENDPOINT_URL,
    status,
    statusReason,
  });
}

export async function upsertPostHogMcpServer(
  workspaceId: string,
  status: "configured" | "missing_credential" | "error",
  statusReason: string | null,
) {
  return upsertMcpServer({
    workspaceId,
    serverKey: POSTHOG_MCP_SERVER_KEY,
    displayName: "PostHog",
    endpointUrl: POSTHOG_MCP_ENDPOINT_URL,
    status,
    statusReason,
  });
}

export async function upsertBetterStackMcpServer(
  workspaceId: string,
  status: "configured" | "missing_credential" | "error",
  statusReason: string | null,
) {
  return upsertMcpServer({
    workspaceId,
    serverKey: BETTERSTACK_MCP_SERVER_KEY,
    displayName: "Better Stack",
    endpointUrl: BETTERSTACK_MCP_ENDPOINT_URL,
    status,
    statusReason,
  });
}

async function upsertMcpServer(input: {
  workspaceId: string;
  serverKey: McpProviderKey;
  displayName: string;
  endpointUrl: string;
  status: "configured" | "missing_credential" | "error";
  statusReason: string | null;
}) {
  const now = new Date();
  const [server] = await getDb()
    .insert(workspaceMcpServers)
    .values({
      id: newWorkspaceMcpServerId(),
      workspaceId: input.workspaceId,
      serverKey: input.serverKey,
      displayName: input.displayName,
      endpointUrl: input.endpointUrl,
      status: input.status,
      statusReason: input.statusReason,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceMcpServers.workspaceId, workspaceMcpServers.serverKey],
      set: {
        displayName: input.displayName,
        endpointUrl: input.endpointUrl,
        status: input.status,
        statusReason: input.statusReason,
        updatedAt: now,
      },
    })
    .returning({ id: workspaceMcpServers.id });

  if (!server) throw new Error(`Could not persist ${input.displayName} MCP server.`);
  return server;
}

function newWorkspaceMcpServerId() {
  return `wmcps_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function revalidateMcpPaths() {
  revalidatePath("/company/settings");
  revalidatePath("/company/agents");
}
