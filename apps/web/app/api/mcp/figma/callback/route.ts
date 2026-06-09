import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { upsertFigmaMcpServer } from "@/lib/mcp/actions";
import {
  appendFigmaMcpSetupStatus,
  completeFigmaMcpOAuth,
  verifyFigmaMcpOAuthState,
} from "@/lib/mcp/figma-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  const current = await currentWorkspace({ requireAdmin: true });
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyFigmaMcpOAuthState(stateValue);
  } catch (error) {
    await upsertFigmaMcpServer(
      current.workspace.id,
      "error",
      "Figma MCP token exchange failed. Try reconnecting Figma.",
    );
    captureException(error, {
      event: "opencompany.figma_mcp_oauth_callback_failed",
      reason: "invalid_state",
    });
    logger.warn("Figma MCP OAuth callback rejected invalid state", {
      event: "opencompany.figma_mcp_oauth_callback_failed",
      reason: "invalid_state",
      has_state: Boolean(stateValue),
    });
    return NextResponse.redirect(
      new URL("/settings?mcp=figma&setup=error&reason=invalid_state", url),
    );
  }

  if (state.workspaceId !== current.workspace.id || state.userId !== current.user.id) {
    logger.warn("Figma MCP OAuth callback state did not match current session", {
      event: "opencompany.figma_mcp_oauth_callback_failed",
      reason: "state_session_mismatch",
      workspace_matches: state.workspaceId === current.workspace.id,
      user_matches: state.userId === current.user.id,
    });
    return NextResponse.redirect(
      new URL(appendFigmaMcpSetupStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logger.warn("Figma MCP OAuth returned an error", {
      event: "opencompany.figma_mcp_oauth_callback_failed",
      reason: "oauth_error",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      oauth_error: oauthError,
      oauth_error_description: url.searchParams.get("error_description"),
      oauth_error_uri: url.searchParams.get("error_uri"),
    });
    return NextResponse.redirect(
      new URL(appendFigmaMcpSetupStatus(state.returnTo, "error", "figma_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    logger.warn("Figma MCP OAuth callback missing authorization code", {
      event: "opencompany.figma_mcp_oauth_callback_failed",
      reason: "missing_code",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
    });
    return NextResponse.redirect(
      new URL(appendFigmaMcpSetupStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const server = await upsertFigmaMcpServer(
      current.workspace.id,
      "missing_credential",
      "Figma MCP authorization is completing.",
    );
    await completeFigmaMcpOAuth({
      workspaceId: current.workspace.id,
      serverId: server.id,
      code,
      state: stateValue,
    });
    await upsertFigmaMcpServer(current.workspace.id, "configured", null);

    return NextResponse.redirect(
      new URL(appendFigmaMcpSetupStatus(state.returnTo, "connected"), url),
    );
  } catch (error) {
    captureException(error, {
      event: "opencompany.figma_mcp_oauth_callback_failed",
      reason: "token_exchange_failed",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
    });
    logger.error("Figma MCP OAuth callback failed", {
      event: "opencompany.figma_mcp_oauth_callback_failed",
      reason: "token_exchange_failed",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      error_message: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.redirect(
      new URL(appendFigmaMcpSetupStatus(state.returnTo, "error", "token_exchange_failed"), url),
    );
  }
}
