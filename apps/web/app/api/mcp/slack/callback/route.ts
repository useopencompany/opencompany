import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { upsertSlackMcpServer } from "@/lib/mcp/actions";
import {
  appendSlackMcpSetupStatus,
  completeSlackMcpOAuth,
  verifySlackMcpOAuthState,
} from "@/lib/mcp/slack-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  const current = await currentWorkspace({ requireAdmin: true });
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifySlackMcpOAuthState(stateValue);
  } catch (error) {
    await upsertSlackMcpServer(
      current.workspace.id,
      "error",
      "Slack MCP token exchange failed. Try reconnecting Slack.",
    );
    captureException(error, {
      event: "opencompany.slack_mcp_oauth_callback_failed",
      reason: "invalid_state",
    });
    logger.warn("Slack MCP OAuth callback rejected invalid state", {
      event: "opencompany.slack_mcp_oauth_callback_failed",
      reason: "invalid_state",
      has_state: Boolean(stateValue),
    });
    return NextResponse.redirect(
      new URL("/settings?mcp=slack&setup=error&reason=invalid_state", url),
    );
  }

  if (state.workspaceId !== current.workspace.id || state.userId !== current.user.id) {
    logger.warn("Slack MCP OAuth callback state did not match current session", {
      event: "opencompany.slack_mcp_oauth_callback_failed",
      reason: "state_session_mismatch",
      workspace_matches: state.workspaceId === current.workspace.id,
      user_matches: state.userId === current.user.id,
    });
    return NextResponse.redirect(
      new URL(appendSlackMcpSetupStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logger.warn("Slack MCP OAuth returned an error", {
      event: "opencompany.slack_mcp_oauth_callback_failed",
      reason: "oauth_error",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      oauth_error: oauthError,
      oauth_error_description: url.searchParams.get("error_description"),
      oauth_error_uri: url.searchParams.get("error_uri"),
    });
    return NextResponse.redirect(
      new URL(appendSlackMcpSetupStatus(state.returnTo, "error", "slack_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    logger.warn("Slack MCP OAuth callback missing authorization code", {
      event: "opencompany.slack_mcp_oauth_callback_failed",
      reason: "missing_code",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
    });
    return NextResponse.redirect(
      new URL(appendSlackMcpSetupStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const server = await upsertSlackMcpServer(
      current.workspace.id,
      "missing_credential",
      "Slack MCP authorization is completing.",
    );
    await completeSlackMcpOAuth({
      workspaceId: current.workspace.id,
      serverId: server.id,
      code,
      state: stateValue,
    });
    await upsertSlackMcpServer(current.workspace.id, "configured", null);

    return NextResponse.redirect(
      new URL(appendSlackMcpSetupStatus(state.returnTo, "connected"), url),
    );
  } catch (error) {
    captureException(error, {
      event: "opencompany.slack_mcp_oauth_callback_failed",
      reason: "token_exchange_failed",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
    });
    logger.error("Slack MCP OAuth callback failed", {
      event: "opencompany.slack_mcp_oauth_callback_failed",
      reason: "token_exchange_failed",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      error_message: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.redirect(
      new URL(appendSlackMcpSetupStatus(state.returnTo, "error", "token_exchange_failed"), url),
    );
  }
}
