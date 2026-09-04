import { getAppUrl } from "@opencompany/agent/app-url";
import {
  appendBetterStackMcpStatus,
  completeBetterStackMcpOAuth,
  startBetterStackMcpOAuth,
  verifyBetterStackMcpState,
} from "@opencompany/agent/integrations/betterstack-mcp";
import {
  appendHubSpotMcpStatus,
  completeHubSpotMcpOAuth,
  startHubSpotMcpOAuth,
  verifyHubSpotMcpState,
} from "@opencompany/agent/integrations/hubspot-mcp";
import {
  appendJamieMcpStatus,
  completeJamieMcpOAuth,
  startJamieMcpOAuth,
  verifyJamieMcpState,
} from "@opencompany/agent/integrations/jamie-mcp";
import {
  appendLatitudeMcpStatus,
  completeLatitudeMcpOAuth,
  startLatitudeMcpOAuth,
  verifyLatitudeMcpState,
} from "@opencompany/agent/integrations/latitude-mcp";
import {
  appendLinearMcpStatus,
  completeLinearMcpOAuth,
  startLinearMcpOAuth,
  verifyLinearMcpState,
} from "@opencompany/agent/integrations/linear-mcp";
import {
  appendNeonMcpStatus,
  completeNeonMcpOAuth,
  startNeonMcpOAuth,
  verifyNeonMcpState,
} from "@opencompany/agent/integrations/neon-mcp";
import {
  appendPostHogMcpStatus,
  completePostHogMcpOAuth,
  startPostHogMcpOAuth,
  verifyPostHogMcpState,
} from "@opencompany/agent/integrations/posthog-mcp";
import {
  appendSigNozMcpStatus,
  completeSigNozMcpOAuth,
  startSigNozMcpOAuth,
  verifySigNozMcpState,
} from "@opencompany/agent/integrations/signoz-mcp";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "mcp-oauth-ingress" });

type DbLike = any;

export type McpOAuthProvider =
  | "linear"
  | "hubspot"
  | "posthog"
  | "neon"
  | "latitude"
  | "jamie"
  | "betterstack"
  | "signoz";

// Provider ingress composition for the remote-MCP connectors. Each
// provider shares the createRemoteMcpIntegration factory; this module
// owns only the browser-facing OAuth start/callback flows — the runner keeps
// loading worker connections through the module-level defaults.
export type McpOAuthIngressService = {
  start(provider: McpOAuthProvider, request: Request): Promise<Response>;
  callback(provider: McpOAuthProvider, request: Request): Promise<Response>;
};

type McpProviderFlow = {
  start: typeof startLinearMcpOAuth;
  complete: typeof completeLinearMcpOAuth;
  verifyState: typeof verifyLinearMcpState;
  appendStatus: typeof appendLinearMcpStatus;
  deniedReason: string;
  // The retired web routes hard-coded the invalid-state redirect before the
  // state's returnTo was trusted; Linear predates the /settings/integrations
  // surface and kept the older target.
  invalidStatePath: string;
};

const MCP_PROVIDER_FLOWS: Record<McpOAuthProvider, McpProviderFlow> = {
  betterstack: {
    start: startBetterStackMcpOAuth,
    complete: completeBetterStackMcpOAuth,
    verifyState: verifyBetterStackMcpState,
    appendStatus: appendBetterStackMcpStatus,
    deniedReason: "betterstack_denied",
    invalidStatePath:
      "/settings/plugins/betterstack?integration=betterstack&setup=error&reason=invalid_state",
  },
  signoz: {
    start: startSigNozMcpOAuth,
    complete: completeSigNozMcpOAuth,
    verifyState: verifySigNozMcpState,
    appendStatus: appendSigNozMcpStatus,
    deniedReason: "signoz_denied",
    invalidStatePath:
      "/settings/plugins/signoz?integration=signoz&setup=error&reason=invalid_state",
  },
  linear: {
    start: startLinearMcpOAuth,
    complete: completeLinearMcpOAuth,
    verifyState: verifyLinearMcpState,
    appendStatus: appendLinearMcpStatus,
    deniedReason: "linear_denied",
    invalidStatePath: "/settings?integration=linear&setup=error&reason=invalid_state",
  },
  hubspot: {
    start: startHubSpotMcpOAuth,
    complete: completeHubSpotMcpOAuth,
    verifyState: verifyHubSpotMcpState,
    appendStatus: appendHubSpotMcpStatus,
    deniedReason: "hubspot_mcp_denied",
    invalidStatePath:
      "/settings/plugins/hubspot?integration=hubspot&setup=error&reason=invalid_state",
  },
  posthog: {
    start: startPostHogMcpOAuth,
    complete: completePostHogMcpOAuth,
    verifyState: verifyPostHogMcpState,
    appendStatus: appendPostHogMcpStatus,
    deniedReason: "posthog_denied",
    invalidStatePath: "/settings/integrations?integration=posthog&setup=error&reason=invalid_state",
  },
  neon: {
    start: startNeonMcpOAuth,
    complete: completeNeonMcpOAuth,
    verifyState: verifyNeonMcpState,
    appendStatus: appendNeonMcpStatus,
    deniedReason: "neon_denied",
    invalidStatePath: "/settings/integrations?integration=neon&setup=error&reason=invalid_state",
  },
  latitude: {
    start: startLatitudeMcpOAuth,
    complete: completeLatitudeMcpOAuth,
    verifyState: verifyLatitudeMcpState,
    appendStatus: appendLatitudeMcpStatus,
    deniedReason: "latitude_denied",
    invalidStatePath:
      "/settings/integrations?integration=latitude&setup=error&reason=invalid_state",
  },
  jamie: {
    start: startJamieMcpOAuth,
    complete: completeJamieMcpOAuth,
    verifyState: verifyJamieMcpState,
    appendStatus: appendJamieMcpStatus,
    deniedReason: "jamie_denied",
    invalidStatePath: "/settings/plugins/jamie?integration=jamie&setup=error&reason=invalid_state",
  },
};

type RefreshPluginRegistrations = (input: {
  provider: McpOAuthProvider;
  userWorkosId: string;
  workspaceIds: string[];
}) => Promise<void>;

export function createMcpOAuthIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: RefreshPluginRegistrations;
}): McpOAuthIngressService {
  return {
    start: (provider, request) => handleStart(input, provider, request),
    callback: (provider, request) => handleCallback(input, provider, request),
  };
}

type IngressInput = {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: RefreshPluginRegistrations;
};

async function handleStart(
  input: IngressInput,
  provider: McpOAuthProvider,
  request: Request,
): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";
  const flow = MCP_PROVIDER_FLOWS[provider];

  try {
    const result = await flow.start({
      userWorkosId: session.userId,
      returnTo,
      db: input.db,
    });
    if (result.status === "connected") {
      await refreshAfterConnection(input, provider, session);
      return statusRedirect(session, flow, returnTo, "connected");
    }
    return sessionRedirect(session, result.redirectUrl);
  } catch (error) {
    logger.warn("Remote MCP OAuth start failed", {
      event: "goat.mcp_oauth_start_failed",
      provider,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return statusRedirect(session, flow, returnTo, "error", "start_failed");
  }
}

async function handleCallback(
  input: IngressInput,
  provider: McpOAuthProvider,
  request: Request,
): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";
  const flow = MCP_PROVIDER_FLOWS[provider];

  let state: ReturnType<McpProviderFlow["verifyState"]>;
  try {
    state = flow.verifyState(stateValue);
  } catch {
    return sessionRedirect(session, new URL(flow.invalidStatePath, getAppUrl()));
  }

  if (state.userWorkosId !== session.userId) {
    return statusRedirect(session, flow, state.returnTo, "error", "session_mismatch");
  }
  if (url.searchParams.get("error")) {
    return statusRedirect(session, flow, state.returnTo, "error", flow.deniedReason);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return statusRedirect(session, flow, state.returnTo, "error", "missing_code");
  }

  try {
    await flow.complete({
      userWorkosId: session.userId,
      integrationId: state.integrationId,
      code,
      state: stateValue,
      db: input.db,
    });
    await refreshAfterConnection(input, provider, session);
    return statusRedirect(session, flow, state.returnTo, "connected");
  } catch (error) {
    logger.warn("Remote MCP OAuth completion failed", {
      event: "goat.mcp_oauth_complete_failed",
      provider,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return statusRedirect(session, flow, state.returnTo, "error", "token_exchange_failed");
  }
}

async function refreshAfterConnection(
  input: IngressInput,
  provider: McpOAuthProvider,
  session: Extract<IngressSession, { kind: "actor" }>,
) {
  if (!input.refreshPluginRegistrations) return;
  try {
    await input.refreshPluginRegistrations({
      provider,
      userWorkosId: session.userId,
      workspaceIds: session.workspaces.map((entry) => entry.workspace.id),
    });
  } catch (error) {
    logger.warn("Plugin discovery refresh after MCP connection failed", {
      event: "goat.plugin_mcp_reconnect_refresh_failed",
      provider,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  flow: McpProviderFlow,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(flow.appendStatus(returnTo, status, reason), getAppUrl()),
  );
}
