"use server";

import { getDb } from "@opencompany/db/client";
import type { WorkspaceMcpCredentialKind } from "@opencompany/db/schema";
import { workspaceMcpServers } from "@opencompany/db/schema";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import { deleteMcpCredential, saveMcpCredential } from "@/lib/mcp/credential-storage";
import {
  BETTERSTACK_MCP_ENDPOINT_URL,
  BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND,
  BETTERSTACK_MCP_SERVER_KEY,
  BRAINTRUST_MCP_ENDPOINT_URL,
  BRAINTRUST_MCP_OAUTH_CREDENTIAL_KIND,
  BRAINTRUST_MCP_SERVER_KEY,
  LINEAR_MCP_ENDPOINT_URL,
  LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  LINEAR_MCP_SERVER_KEY,
  type McpProviderKey,
  POSTHOG_MCP_ENDPOINT_URL,
  POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
  POSTHOG_MCP_SERVER_KEY,
  SLACK_MCP_ENDPOINT_URL,
  SLACK_MCP_OAUTH_CREDENTIAL_KIND,
  SLACK_MCP_SERVER_KEY,
} from "@/lib/mcp/data";

type McpServerStatus = "configured" | "missing_credential" | "error";

const MCP_SERVER_PRESETS: Record<
  McpProviderKey,
  { displayName: string; endpointUrl: string; oauthCredentialKind: WorkspaceMcpCredentialKind }
> = {
  [LINEAR_MCP_SERVER_KEY]: {
    displayName: "Linear",
    endpointUrl: LINEAR_MCP_ENDPOINT_URL,
    oauthCredentialKind: LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  },
  [SLACK_MCP_SERVER_KEY]: {
    displayName: "Slack",
    endpointUrl: SLACK_MCP_ENDPOINT_URL,
    oauthCredentialKind: SLACK_MCP_OAUTH_CREDENTIAL_KIND,
  },
  [POSTHOG_MCP_SERVER_KEY]: {
    displayName: "PostHog",
    endpointUrl: POSTHOG_MCP_ENDPOINT_URL,
    oauthCredentialKind: POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
  },
  [BETTERSTACK_MCP_SERVER_KEY]: {
    displayName: "Better Stack",
    endpointUrl: BETTERSTACK_MCP_ENDPOINT_URL,
    oauthCredentialKind: BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND,
  },
  [BRAINTRUST_MCP_SERVER_KEY]: {
    displayName: "Braintrust",
    endpointUrl: BRAINTRUST_MCP_ENDPOINT_URL,
    oauthCredentialKind: BRAINTRUST_MCP_OAUTH_CREDENTIAL_KIND,
  },
};

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
    kind: LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  });

  revalidateMcpPaths();
  return { ok: true as const };
}

export async function removeLinearMcpToken() {
  return removeMcpCredentials(LINEAR_MCP_SERVER_KEY, "Linear MCP token was removed.", [
    "bearer_token",
    LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  ]);
}

export async function removeSlackMcpConnection() {
  return removeMcpCredentials(SLACK_MCP_SERVER_KEY, "Slack MCP connection was removed.");
}

export async function removePostHogMcpConnection() {
  return removeMcpCredentials(POSTHOG_MCP_SERVER_KEY, "PostHog MCP connection was removed.");
}

export async function removeBetterStackMcpConnection() {
  return removeMcpCredentials(
    BETTERSTACK_MCP_SERVER_KEY,
    "Better Stack MCP connection was removed.",
  );
}

export async function removeBraintrustMcpConnection() {
  return removeMcpCredentials(BRAINTRUST_MCP_SERVER_KEY, "Braintrust MCP connection was removed.");
}

export async function upsertLinearMcpServer(
  workspaceId: string,
  status: McpServerStatus,
  statusReason: string | null,
) {
  return upsertProviderMcpServer(LINEAR_MCP_SERVER_KEY, workspaceId, status, statusReason);
}

export async function upsertSlackMcpServer(
  workspaceId: string,
  status: McpServerStatus,
  statusReason: string | null,
) {
  return upsertProviderMcpServer(SLACK_MCP_SERVER_KEY, workspaceId, status, statusReason);
}

export async function upsertPostHogMcpServer(
  workspaceId: string,
  status: McpServerStatus,
  statusReason: string | null,
) {
  return upsertProviderMcpServer(POSTHOG_MCP_SERVER_KEY, workspaceId, status, statusReason);
}

export async function upsertBetterStackMcpServer(
  workspaceId: string,
  status: McpServerStatus,
  statusReason: string | null,
) {
  return upsertProviderMcpServer(BETTERSTACK_MCP_SERVER_KEY, workspaceId, status, statusReason);
}

export async function upsertBraintrustMcpServer(
  workspaceId: string,
  status: McpServerStatus,
  statusReason: string | null,
) {
  return upsertProviderMcpServer(BRAINTRUST_MCP_SERVER_KEY, workspaceId, status, statusReason);
}

async function removeMcpCredentials(
  provider: McpProviderKey,
  statusReason: string,
  kinds?: WorkspaceMcpCredentialKind[],
) {
  const { workspace } = await currentWorkspace({ requireAdmin: true });
  const server = await upsertProviderMcpServer(
    provider,
    workspace.id,
    "missing_credential",
    statusReason,
  );
  for (const kind of kinds ?? [MCP_SERVER_PRESETS[provider].oauthCredentialKind]) {
    await deleteMcpCredential({
      workspaceId: workspace.id,
      serverId: server.id,
      kind,
    });
  }

  revalidateMcpPaths();
  return { ok: true as const };
}

async function upsertProviderMcpServer(
  provider: McpProviderKey,
  workspaceId: string,
  status: McpServerStatus,
  statusReason: string | null,
) {
  const preset = MCP_SERVER_PRESETS[provider];
  return upsertMcpServer({
    workspaceId,
    serverKey: provider,
    displayName: preset.displayName,
    endpointUrl: preset.endpointUrl,
    status,
    statusReason,
  });
}

async function upsertMcpServer(input: {
  workspaceId: string;
  serverKey: McpProviderKey;
  displayName: string;
  endpointUrl: string;
  status: McpServerStatus;
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
