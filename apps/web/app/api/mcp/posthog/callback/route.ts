import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { upsertPostHogMcpServer } from "@/lib/mcp/actions";
import {
  appendPostHogMcpSetupStatus,
  completePostHogMcpOAuth,
  verifyPostHogMcpOAuthState,
} from "@/lib/mcp/posthog-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function GET(request: Request) {
  // skipOnboarding: the onboarding integrations step opens this OAuth flow in a popup before
  // onboarding is marked complete; the default gate would bounce the popup to /onboarding.
  const current = await currentWorkspace({ requireAdmin: true, skipOnboarding: true });
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyPostHogMcpOAuthState(stateValue);
  } catch (error) {
    await upsertPostHogMcpServer(
      current.workspace.id,
      "error",
      "PostHog MCP token exchange failed. Try reconnecting PostHog.",
    );
    captureException(error, {
      event: "opencompany.posthog_mcp_oauth_callback_failed",
      reason: "invalid_state",
    });
    logger.warn("PostHog MCP OAuth callback rejected invalid state", {
      event: "opencompany.posthog_mcp_oauth_callback_failed",
      reason: "invalid_state",
      has_state: Boolean(stateValue),
    });
    return NextResponse.redirect(
      new URL("/settings?mcp=posthog&setup=error&reason=invalid_state", url),
    );
  }

  if (state.workspaceId !== current.workspace.id || state.userId !== current.user.id) {
    logger.warn("PostHog MCP OAuth callback state did not match current session", {
      event: "opencompany.posthog_mcp_oauth_callback_failed",
      reason: "state_session_mismatch",
      workspace_matches: state.workspaceId === current.workspace.id,
      user_matches: state.userId === current.user.id,
    });
    return NextResponse.redirect(
      new URL(appendPostHogMcpSetupStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logger.warn("PostHog MCP OAuth returned an error", {
      event: "opencompany.posthog_mcp_oauth_callback_failed",
      reason: "oauth_error",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      oauth_error: oauthError,
      oauth_error_description: url.searchParams.get("error_description"),
      oauth_error_uri: url.searchParams.get("error_uri"),
    });
    return NextResponse.redirect(
      new URL(appendPostHogMcpSetupStatus(state.returnTo, "error", "posthog_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    logger.warn("PostHog MCP OAuth callback missing authorization code", {
      event: "opencompany.posthog_mcp_oauth_callback_failed",
      reason: "missing_code",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
    });
    return NextResponse.redirect(
      new URL(appendPostHogMcpSetupStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const server = await upsertPostHogMcpServer(
      current.workspace.id,
      "missing_credential",
      "PostHog MCP authorization is completing.",
    );
    await completePostHogMcpOAuth({
      workspaceId: current.workspace.id,
      serverId: server.id,
      code,
      state: stateValue,
    });
    await upsertPostHogMcpServer(current.workspace.id, "configured", null);

    return NextResponse.redirect(
      new URL(appendPostHogMcpSetupStatus(state.returnTo, "connected"), url),
    );
  } catch (error) {
    captureException(error, {
      event: "opencompany.posthog_mcp_oauth_callback_failed",
      reason: "token_exchange_failed",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
    });
    logger.error("PostHog MCP OAuth callback failed", {
      event: "opencompany.posthog_mcp_oauth_callback_failed",
      reason: "token_exchange_failed",
      workspace_id: current.workspace.id,
      user_id: current.user.id,
      error_message: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.redirect(
      new URL(appendPostHogMcpSetupStatus(state.returnTo, "error", "token_exchange_failed"), url),
    );
  }
}
