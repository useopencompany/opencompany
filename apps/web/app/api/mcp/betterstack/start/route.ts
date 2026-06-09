import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { upsertBetterStackMcpServer } from "@/lib/mcp/actions";
import {
  appendBetterStackMcpSetupStatus,
  startBetterStackMcpOAuth,
} from "@/lib/mcp/betterstack-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  const { user, workspace } = await currentWorkspace({ requireAdmin: true });
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const server = await upsertBetterStackMcpServer(
      workspace.id,
      "missing_credential",
      "Better Stack MCP authorization started.",
    );
    const result = await startBetterStackMcpOAuth({
      workspaceId: workspace.id,
      userId: user.id,
      serverId: server.id,
      returnTo,
    });

    if (result.status === "connected") {
      await upsertBetterStackMcpServer(workspace.id, "configured", null);
      return NextResponse.redirect(
        new URL(appendBetterStackMcpSetupStatus(returnTo, "connected"), url),
      );
    }

    return NextResponse.redirect(result.redirectUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await upsertBetterStackMcpServer(
      workspace.id,
      "error",
      betterstackMcpOAuthStartStatusReason(errorMessage),
    );
    captureException(error, {
      event: "opencompany.betterstack_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
    });
    logger.error("Better Stack MCP OAuth start failed", {
      event: "opencompany.betterstack_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      error_message: errorMessage,
    });
    return NextResponse.redirect(
      new URL(appendBetterStackMcpSetupStatus(returnTo, "error", "start_failed"), url),
    );
  }
}

function betterstackMcpOAuthStartStatusReason(errorMessage: string) {
  if (errorMessage.includes("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY")) {
    return "Set INTEGRATION_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key, then reconnect Better Stack.";
  }
  return "Better Stack MCP authorization could not start.";
}
