import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import type { McpOAuthProvider } from "@/lib/mcp/oauth-provider";

// Shared GET handlers for the per-provider /api/mcp/<key>/{start,callback} routes.
// Each route file is a one-liner: `export const GET = createMcpOAuthStartRoute(provider, upsert)`.

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

type UpsertMcpServer = (
  workspaceId: string,
  status: "configured" | "missing_credential" | "error",
  statusReason: string | null,
) => Promise<{ id: string }>;

export function createMcpOAuthStartRoute(
  provider: McpOAuthProvider,
  upsertServer: UpsertMcpServer,
) {
  const failureEvent = `opencompany.${provider.key}_mcp_oauth_start_failed`;

  return async function GET(request: Request) {
    // skipOnboarding: the onboarding integrations step opens this OAuth flow in a popup before
    // onboarding is marked complete; the default gate would bounce the popup to /onboarding.
    //
    // requireAdmin is intentionally dropped for multi-account providers: each member connects
    // their own account (stored per-account, removable only by the connector or an admin), so
    // connecting is a per-member action rather than an admin-only workspace setting.
    const { user, workspace } = await currentWorkspace({
      ...(provider.multipleAccounts ? {} : { requireAdmin: true }),
      skipOnboarding: true,
    });
    const url = new URL(request.url);
    const returnTo = url.searchParams.get("returnTo") ?? "/company/settings";

    try {
      const server = await upsertServer(
        workspace.id,
        provider.multipleAccounts ? "configured" : "missing_credential",
        provider.multipleAccounts ? null : `${provider.displayName} MCP authorization started.`,
      );
      const result = await provider.start({
        workspaceId: workspace.id,
        userId: user.id,
        serverId: server.id,
        returnTo,
      });

      if (result.status === "connected") {
        await upsertServer(workspace.id, "configured", null);
        return NextResponse.redirect(
          new URL(provider.appendSetupStatus(returnTo, "connected"), url),
        );
      }

      return NextResponse.redirect(result.redirectUrl);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await upsertServer(workspace.id, "error", provider.startFailureStatusReason(errorMessage));
      captureException(error, {
        event: failureEvent,
        workspace_id: workspace.id,
        user_id: user.id,
      });
      logger.error(`${provider.displayName} MCP OAuth start failed`, {
        event: failureEvent,
        workspace_id: workspace.id,
        user_id: user.id,
        error_message: errorMessage,
      });
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(returnTo, "error", "start_failed"), url),
      );
    }
  };
}

export function createMcpOAuthCallbackRoute(
  provider: McpOAuthProvider,
  upsertServer: UpsertMcpServer,
) {
  const failureEvent = `opencompany.${provider.key}_mcp_oauth_callback_failed`;

  return async function GET(request: Request) {
    // skipOnboarding: the onboarding integrations step opens this OAuth flow in a popup before
    // onboarding is marked complete; the default gate would bounce the popup to /onboarding.
    // requireAdmin dropped for multi-account providers — see the start route for the rationale.
    const current = await currentWorkspace({
      ...(provider.multipleAccounts ? {} : { requireAdmin: true }),
      skipOnboarding: true,
    });
    const url = new URL(request.url);
    const stateValue = url.searchParams.get("state") ?? "";

    let state;
    try {
      state = provider.verifyState(stateValue);
    } catch (error) {
      // The state is unauthenticated input — a stray or forged callback must not mutate the
      // stored server status, otherwise it could degrade a healthy connection.
      captureException(error, { event: failureEvent, reason: "invalid_state" });
      logger.warn(`${provider.displayName} MCP OAuth callback rejected invalid state`, {
        event: failureEvent,
        reason: "invalid_state",
        has_state: Boolean(stateValue),
      });
      return NextResponse.redirect(
        new URL(`/company/settings?mcp=${provider.key}&setup=error&reason=invalid_state`, url),
      );
    }

    if (state.workspaceId !== current.workspace.id || state.userId !== current.user.id) {
      logger.warn(
        `${provider.displayName} MCP OAuth callback state did not match current session`,
        {
          event: failureEvent,
          reason: "state_session_mismatch",
          workspace_matches: state.workspaceId === current.workspace.id,
          user_matches: state.userId === current.user.id,
        },
      );
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "error", "session_mismatch"), url),
      );
    }

    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      logger.warn(`${provider.displayName} MCP OAuth returned an error`, {
        event: failureEvent,
        reason: "oauth_error",
        workspace_id: current.workspace.id,
        user_id: current.user.id,
        oauth_error: oauthError,
        oauth_error_description: url.searchParams.get("error_description"),
        oauth_error_uri: url.searchParams.get("error_uri"),
      });
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "error", provider.deniedReason), url),
      );
    }

    const code = url.searchParams.get("code");
    if (!code) {
      logger.warn(`${provider.displayName} MCP OAuth callback missing authorization code`, {
        event: failureEvent,
        reason: "missing_code",
        workspace_id: current.workspace.id,
        user_id: current.user.id,
      });
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "error", "missing_code"), url),
      );
    }

    try {
      const server = await upsertServer(
        current.workspace.id,
        "missing_credential",
        `${provider.displayName} MCP authorization is completing.`,
      );
      await provider.complete({
        workspaceId: current.workspace.id,
        userId: current.user.id,
        serverId: server.id,
        ...(state.credentialAccountKey ? { accountKey: state.credentialAccountKey } : {}),
        code,
        state: stateValue,
      });
      await upsertServer(current.workspace.id, "configured", null);

      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "connected"), url),
      );
    } catch (error) {
      await upsertServer(
        current.workspace.id,
        "error",
        `${provider.displayName} MCP token exchange failed. Try reconnecting ${provider.displayName}.`,
      );
      captureException(error, {
        event: failureEvent,
        reason: "token_exchange_failed",
        workspace_id: current.workspace.id,
        user_id: current.user.id,
      });
      logger.error(`${provider.displayName} MCP OAuth callback failed`, {
        event: failureEvent,
        reason: "token_exchange_failed",
        workspace_id: current.workspace.id,
        user_id: current.user.id,
        error_message: error instanceof Error ? error.message : "Unknown error",
      });
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "error", "token_exchange_failed"), url),
      );
    }
  };
}
