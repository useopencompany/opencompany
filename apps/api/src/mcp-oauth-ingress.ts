import { getAppUrl } from "@opencompany/agent/app-url";
import {
  appendAttioMcpStatus,
  completeAttioMcpOAuth,
  startAttioMcpOAuth,
  verifyAttioMcpState,
} from "@opencompany/agent/integrations/attio-mcp";
import {
  appendBetterStackMcpStatus,
  completeBetterStackMcpOAuth,
  startBetterStackMcpOAuth,
  verifyBetterStackMcpState,
} from "@opencompany/agent/integrations/betterstack-mcp";
import {
  appendFathomMcpStatus,
  completeFathomMcpOAuth,
  startFathomMcpOAuth,
  verifyFathomMcpState,
} from "@opencompany/agent/integrations/fathom-mcp";
import {
  appendGranolaMcpStatus,
  completeGranolaMcpOAuth,
  startGranolaMcpOAuth,
  verifyGranolaMcpState,
} from "@opencompany/agent/integrations/granola-mcp";
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
  appendNotionMcpStatus,
  completeNotionMcpOAuth,
  startNotionMcpOAuth,
  verifyNotionMcpState,
} from "@opencompany/agent/integrations/notion-mcp";
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
import {
  appendVercelMcpStatus,
  completeVercelMcpOAuth,
  startVercelMcpOAuth,
  verifyVercelMcpState,
} from "@opencompany/agent/integrations/vercel-mcp";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "mcp-oauth-ingress" });

type DbLike = any;

export type McpOAuthProvider =
  | "attio"
  | "linear"
  | "hubspot"
  | "granola"
  | "posthog"
  | "neon"
  | "notion"
  | "latitude"
  | "jamie"
  | "betterstack"
  | "fathom"
  | "signoz"
  | "vercel";

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
  unavailableReason?: string;
};

const MCP_PROVIDER_FLOWS: Record<McpOAuthProvider, McpProviderFlow> = {
  attio: {
    start: startAttioMcpOAuth,
    complete: completeAttioMcpOAuth,
    verifyState: verifyAttioMcpState,
    appendStatus: appendAttioMcpStatus,
    deniedReason: "attio_mcp_denied",
  },
  betterstack: {
    start: startBetterStackMcpOAuth,
    complete: completeBetterStackMcpOAuth,
    verifyState: verifyBetterStackMcpState,
    appendStatus: appendBetterStackMcpStatus,
    deniedReason: "betterstack_denied",
  },
  fathom: {
    start: startFathomMcpOAuth,
    complete: completeFathomMcpOAuth,
    verifyState: verifyFathomMcpState,
    appendStatus: appendFathomMcpStatus,
    deniedReason: "fathom_denied",
  },
  signoz: {
    start: startSigNozMcpOAuth,
    complete: completeSigNozMcpOAuth,
    verifyState: verifySigNozMcpState,
    appendStatus: appendSigNozMcpStatus,
    deniedReason: "signoz_denied",
  },
  vercel: {
    start: startVercelMcpOAuth,
    complete: completeVercelMcpOAuth,
    verifyState: verifyVercelMcpState,
    appendStatus: appendVercelMcpStatus,
    deniedReason: "vercel_denied",
    unavailableReason: "provider_approval_required",
  },
  linear: {
    start: startLinearMcpOAuth,
    complete: completeLinearMcpOAuth,
    verifyState: verifyLinearMcpState,
    appendStatus: appendLinearMcpStatus,
    deniedReason: "linear_denied",
  },
  hubspot: {
    start: startHubSpotMcpOAuth,
    complete: completeHubSpotMcpOAuth,
    verifyState: verifyHubSpotMcpState,
    appendStatus: appendHubSpotMcpStatus,
    deniedReason: "hubspot_mcp_denied",
  },
  granola: {
    start: startGranolaMcpOAuth,
    complete: completeGranolaMcpOAuth,
    verifyState: verifyGranolaMcpState,
    appendStatus: appendGranolaMcpStatus,
    deniedReason: "granola_denied",
  },
  posthog: {
    start: startPostHogMcpOAuth,
    complete: completePostHogMcpOAuth,
    verifyState: verifyPostHogMcpState,
    appendStatus: appendPostHogMcpStatus,
    deniedReason: "posthog_denied",
  },
  neon: {
    start: startNeonMcpOAuth,
    complete: completeNeonMcpOAuth,
    verifyState: verifyNeonMcpState,
    appendStatus: appendNeonMcpStatus,
    deniedReason: "neon_denied",
  },
  notion: {
    start: startNotionMcpOAuth,
    complete: completeNotionMcpOAuth,
    verifyState: verifyNotionMcpState,
    appendStatus: appendNotionMcpStatus,
    deniedReason: "notion_denied",
  },
  latitude: {
    start: startLatitudeMcpOAuth,
    complete: completeLatitudeMcpOAuth,
    verifyState: verifyLatitudeMcpState,
    appendStatus: appendLatitudeMcpStatus,
    deniedReason: "latitude_denied",
  },
  jamie: {
    start: startJamieMcpOAuth,
    complete: completeJamieMcpOAuth,
    verifyState: verifyJamieMcpState,
    appendStatus: appendJamieMcpStatus,
    deniedReason: "jamie_denied",
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
  const returnTo = url.searchParams.get("returnTo") ?? pluginSettingsPath(provider);
  const flow = MCP_PROVIDER_FLOWS[provider];

  if (flow.unavailableReason) {
    return statusRedirect(session, flow, returnTo, "error", flow.unavailableReason);
  }

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
    return statusRedirect(session, flow, pluginSettingsPath(provider), "error", "invalid_state");
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

function pluginSettingsPath(provider: McpOAuthProvider) {
  return `/settings/plugins/${provider}`;
}
