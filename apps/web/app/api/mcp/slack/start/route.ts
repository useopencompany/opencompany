import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { upsertSlackMcpServer } from "@/lib/mcp/actions";
import { appendSlackMcpSetupStatus, startSlackMcpOAuth } from "@/lib/mcp/slack-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  const { user, workspace } = await currentWorkspace({ requireAdmin: true });
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const server = await upsertSlackMcpServer(
      workspace.id,
      "missing_credential",
      "Slack MCP authorization started.",
    );
    const result = await startSlackMcpOAuth({
      workspaceId: workspace.id,
      userId: user.id,
      serverId: server.id,
      returnTo,
    });

    if (result.status === "connected") {
      await upsertSlackMcpServer(workspace.id, "configured", null);
      return NextResponse.redirect(new URL(appendSlackMcpSetupStatus(returnTo, "connected"), url));
    }

    return NextResponse.redirect(result.redirectUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await upsertSlackMcpServer(workspace.id, "error", slackMcpOAuthStartStatusReason(errorMessage));
    captureException(error, {
      event: "opencompany.slack_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
    });
    logger.error("Slack MCP OAuth start failed", {
      event: "opencompany.slack_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      error_message: errorMessage,
    });
    return NextResponse.redirect(
      new URL(appendSlackMcpSetupStatus(returnTo, "error", "start_failed"), url),
    );
  }
}

function slackMcpOAuthStartStatusReason(errorMessage: string) {
  if (errorMessage.includes("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY")) {
    return "Set INTEGRATION_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key, then reconnect Slack.";
  }
  if (errorMessage.includes("SLACK_MCP_CLIENT_ID")) {
    return "Set SLACK_MCP_CLIENT_ID, then reconnect Slack.";
  }
  if (errorMessage.includes("SLACK_MCP_CLIENT_SECRET")) {
    return "Set SLACK_MCP_CLIENT_SECRET, then reconnect Slack.";
  }
  return "Slack MCP authorization could not start.";
}
