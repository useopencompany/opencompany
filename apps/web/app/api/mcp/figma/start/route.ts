import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { upsertFigmaMcpServer } from "@/lib/mcp/actions";
import { appendFigmaMcpSetupStatus, startFigmaMcpOAuth } from "@/lib/mcp/figma-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  const { user, workspace } = await currentWorkspace({ requireAdmin: true });
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const server = await upsertFigmaMcpServer(
      workspace.id,
      "missing_credential",
      "Figma MCP authorization started.",
    );
    const result = await startFigmaMcpOAuth({
      workspaceId: workspace.id,
      userId: user.id,
      serverId: server.id,
      returnTo,
    });

    if (result.status === "connected") {
      await upsertFigmaMcpServer(workspace.id, "configured", null);
      return NextResponse.redirect(new URL(appendFigmaMcpSetupStatus(returnTo, "connected"), url));
    }

    return NextResponse.redirect(result.redirectUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await upsertFigmaMcpServer(workspace.id, "error", figmaMcpOAuthStartStatusReason(errorMessage));
    captureException(error, {
      event: "opencompany.figma_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
    });
    logger.error("Figma MCP OAuth start failed", {
      event: "opencompany.figma_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      error_message: errorMessage,
    });
    return NextResponse.redirect(
      new URL(appendFigmaMcpSetupStatus(returnTo, "error", "start_failed"), url),
    );
  }
}

function figmaMcpOAuthStartStatusReason(errorMessage: string) {
  if (errorMessage.includes("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY")) {
    return "Set INTEGRATION_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key, then reconnect Figma.";
  }
  return "Figma MCP authorization could not start.";
}
