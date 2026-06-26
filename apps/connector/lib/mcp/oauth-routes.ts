import { NextResponse } from "next/server";
import { currentConnectorOrganization } from "@/lib/auth";
import type { createConnectorMcpOAuthProvider } from "./oauth-provider";

type ConnectorMcpOAuthProvider = ReturnType<typeof createConnectorMcpOAuthProvider>;

type UpsertConnectorMcpServer = (input: {
  organizationId: string;
  status: "configured" | "missing_credential" | "error";
  statusReason: string | null;
  connectedByUserId?: string | null;
}) => Promise<{ id: string }>;

export function createConnectorMcpOAuthStartRoute(
  provider: ConnectorMcpOAuthProvider,
  upsertServer: UpsertConnectorMcpServer,
) {
  return async function GET(request: Request) {
    const { user, organization } = await currentConnectorOrganization();
    const url = new URL(request.url);
    const returnTo = url.searchParams.get("returnTo") ?? "/setup";

    try {
      const server = await upsertServer({
        organizationId: organization.id,
        status: "missing_credential",
        statusReason: `${provider.displayName} MCP authorization started.`,
        connectedByUserId: user.id,
      });
      const result = await provider.start({
        organizationId: organization.id,
        userId: user.id,
        serverId: server.id,
        returnTo,
      });

      if (result.status === "connected") {
        await upsertServer({
          organizationId: organization.id,
          status: "configured",
          statusReason: null,
          connectedByUserId: user.id,
        });
        return NextResponse.redirect(
          new URL(provider.appendSetupStatus(returnTo, "connected"), url),
        );
      }

      return NextResponse.redirect(result.redirectUrl);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await upsertServer({
        organizationId: organization.id,
        status: "error",
        statusReason: provider.startFailureStatusReason(errorMessage),
        connectedByUserId: user.id,
      });
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(returnTo, "error", "start_failed"), url),
      );
    }
  };
}

export function createConnectorMcpOAuthCallbackRoute(
  provider: ConnectorMcpOAuthProvider,
  upsertServer: UpsertConnectorMcpServer,
) {
  return async function GET(request: Request) {
    const current = await currentConnectorOrganization();
    const url = new URL(request.url);
    const stateValue = url.searchParams.get("state") ?? "";

    let state;
    try {
      state = provider.verifyState(stateValue);
    } catch {
      return NextResponse.redirect(
        new URL(`/setup?mcp=${provider.key}&setup=error&reason=invalid_state`, url),
      );
    }

    if (state.organizationId !== current.organization.id || state.userId !== current.user.id) {
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "error", "session_mismatch"), url),
      );
    }

    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "error", `${provider.key}_denied`), url),
      );
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "error", "missing_code"), url),
      );
    }

    try {
      const server = await upsertServer({
        organizationId: current.organization.id,
        status: "missing_credential",
        statusReason: `${provider.displayName} MCP authorization is completing.`,
        connectedByUserId: current.user.id,
      });
      await provider.complete({
        organizationId: current.organization.id,
        serverId: server.id,
        code,
        state: stateValue,
      });
      await upsertServer({
        organizationId: current.organization.id,
        status: "configured",
        statusReason: null,
        connectedByUserId: current.user.id,
      });

      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "connected"), url),
      );
    } catch {
      await upsertServer({
        organizationId: current.organization.id,
        status: "error",
        statusReason: `${provider.displayName} MCP token exchange failed. Try reconnecting ${provider.displayName}.`,
        connectedByUserId: current.user.id,
      });
      return NextResponse.redirect(
        new URL(provider.appendSetupStatus(state.returnTo, "error", "token_exchange_failed"), url),
      );
    }
  };
}
