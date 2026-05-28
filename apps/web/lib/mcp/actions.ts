"use server";

import { getDb } from "@opencompany/db/client";
import { workspaceExperiments, workspaceMcpServers } from "@opencompany/db/schema";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import { deleteMcpCredential, saveMcpCredential } from "@/lib/mcp/credential-storage";
import { LINEAR_MCP_ENDPOINT_URL, LINEAR_MCP_SERVER_KEY, MCP_EXPERIMENT_KEY } from "@/lib/mcp/data";
import { linearMcpOAuthCredentialKind } from "@/lib/mcp/linear-oauth";

export async function setWorkspaceMcpExperimentEnabled(enabled: boolean) {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const now = new Date();

  await getDb()
    .insert(workspaceExperiments)
    .values({
      workspaceId: workspace.id,
      key: MCP_EXPERIMENT_KEY,
      enabled,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceExperiments.workspaceId, workspaceExperiments.key],
      set: { enabled, updatedAt: now },
    });

  revalidateMcpPaths();
  return { ok: true as const, enabled };
}

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

export async function upsertLinearMcpServer(
  workspaceId: string,
  status: "configured" | "missing_credential" | "error",
  statusReason: string | null,
) {
  const now = new Date();
  const [server] = await getDb()
    .insert(workspaceMcpServers)
    .values({
      id: newWorkspaceMcpServerId(),
      workspaceId,
      serverKey: LINEAR_MCP_SERVER_KEY,
      displayName: "Linear",
      endpointUrl: LINEAR_MCP_ENDPOINT_URL,
      status,
      statusReason,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceMcpServers.workspaceId, workspaceMcpServers.serverKey],
      set: {
        displayName: "Linear",
        endpointUrl: LINEAR_MCP_ENDPOINT_URL,
        status,
        statusReason,
        updatedAt: now,
      },
    })
    .returning({ id: workspaceMcpServers.id });

  if (!server) throw new Error("Could not persist Linear MCP server.");
  return server;
}

function newWorkspaceMcpServerId() {
  return `wmcps_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function revalidateMcpPaths() {
  revalidatePath("/settings");
  revalidatePath("/agents");
}
