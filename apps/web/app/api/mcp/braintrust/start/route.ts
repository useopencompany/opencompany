import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { upsertBraintrustMcpServer } from "@/lib/mcp/actions";
import {
  appendBraintrustMcpSetupStatus,
  startBraintrustMcpOAuth,
} from "@/lib/mcp/braintrust-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  const { user, workspace } = await currentWorkspace({ requireAdmin: true });
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const server = await upsertBraintrustMcpServer(
      workspace.id,
      "missing_credential",
      "Braintrust MCP authorization started.",
    );
    const result = await startBraintrustMcpOAuth({
      workspaceId: workspace.id,
      userId: user.id,
      serverId: server.id,
      returnTo,
    });

    if (result.status === "connected") {
      await upsertBraintrustMcpServer(workspace.id, "configured", null);
      return NextResponse.redirect(
        new URL(appendBraintrustMcpSetupStatus(returnTo, "connected"), url),
      );
    }

    return NextResponse.redirect(result.redirectUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await upsertBraintrustMcpServer(
      workspace.id,
      "error",
      braintrustMcpOAuthStartStatusReason(errorMessage),
    );
    captureException(error, {
      event: "opencompany.braintrust_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
    });
    logger.error("Braintrust MCP OAuth start failed", {
      event: "opencompany.braintrust_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      error_message: errorMessage,
    });
    return NextResponse.redirect(
      new URL(appendBraintrustMcpSetupStatus(returnTo, "error", "start_failed"), url),
    );
  }
}

function braintrustMcpOAuthStartStatusReason(errorMessage: string) {
  if (errorMessage.includes("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY")) {
    return "Set INTEGRATION_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key, then reconnect Braintrust.";
  }
  return "Braintrust MCP authorization could not start.";
}
