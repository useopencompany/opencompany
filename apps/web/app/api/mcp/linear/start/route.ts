import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { upsertLinearMcpServer } from "@/lib/mcp/actions";
import { appendLinearMcpSetupStatus, startLinearMcpOAuth } from "@/lib/mcp/linear-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  // skipOnboarding: the onboarding integrations step opens this OAuth flow in a popup before
  // onboarding is marked complete; the default gate would bounce the popup to /onboarding.
  const { user, workspace } = await currentWorkspace({ requireAdmin: true, skipOnboarding: true });
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const server = await upsertLinearMcpServer(
      workspace.id,
      "missing_credential",
      "Linear MCP authorization started.",
    );
    const result = await startLinearMcpOAuth({
      workspaceId: workspace.id,
      userId: user.id,
      serverId: server.id,
      returnTo,
    });

    if (result.status === "connected") {
      await upsertLinearMcpServer(workspace.id, "configured", null);
      return NextResponse.redirect(new URL(appendLinearMcpSetupStatus(returnTo, "connected"), url));
    }

    return NextResponse.redirect(result.redirectUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await upsertLinearMcpServer(
      workspace.id,
      "error",
      linearMcpOAuthStartStatusReason(errorMessage),
    );
    captureException(error, {
      event: "opencompany.linear_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
    });
    logger.error("Linear MCP OAuth start failed", {
      event: "opencompany.linear_mcp_oauth_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      error_message: errorMessage,
    });
    return NextResponse.redirect(
      new URL(appendLinearMcpSetupStatus(returnTo, "error", "start_failed"), url),
    );
  }
}

function linearMcpOAuthStartStatusReason(errorMessage: string) {
  if (errorMessage.includes("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY")) {
    return "Set INTEGRATION_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key, then reconnect Linear.";
  }
  return "Linear MCP authorization could not start.";
}
