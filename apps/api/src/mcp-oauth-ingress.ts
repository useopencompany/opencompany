import { getGoatAppUrl } from "@opencompany/goat-agent/app-url";
import {
  appendGoatLatitudeMcpStatus,
  completeGoatLatitudeMcpOAuth,
  startGoatLatitudeMcpOAuth,
  verifyGoatLatitudeMcpState,
} from "@opencompany/goat-agent/integrations/latitude-mcp";
import {
  appendGoatLinearMcpStatus,
  completeGoatLinearMcpOAuth,
  startGoatLinearMcpOAuth,
  verifyGoatLinearMcpState,
} from "@opencompany/goat-agent/integrations/linear-mcp";
import {
  appendGoatNeonMcpStatus,
  completeGoatNeonMcpOAuth,
  startGoatNeonMcpOAuth,
  verifyGoatNeonMcpState,
} from "@opencompany/goat-agent/integrations/neon-mcp";
import {
  appendGoatPostHogMcpStatus,
  completeGoatPostHogMcpOAuth,
  startGoatPostHogMcpOAuth,
  verifyGoatPostHogMcpState,
} from "@opencompany/goat-agent/integrations/posthog-mcp";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "mcp-oauth-ingress" });

type DbLike = any;

export type McpOAuthProvider = "linear" | "posthog" | "neon" | "latitude";

// Provider ingress composition for the four remote-MCP connectors. Each
// provider shares the createGoatRemoteMcpIntegration factory; this module
// owns only the browser-facing OAuth start/callback flows — the runner keeps
// loading worker connections through the module-level defaults.
export type McpOAuthIngressService = {
  start(provider: McpOAuthProvider, request: Request): Promise<Response>;
  callback(provider: McpOAuthProvider, request: Request): Promise<Response>;
};

type McpProviderFlow = {
  start: typeof startGoatLinearMcpOAuth;
  complete: typeof completeGoatLinearMcpOAuth;
  verifyState: typeof verifyGoatLinearMcpState;
  appendStatus: typeof appendGoatLinearMcpStatus;
  deniedReason: string;
  // The retired web routes hard-coded the invalid-state redirect before the
  // state's returnTo was trusted; Linear predates the /settings/integrations
  // surface and kept the older target.
  invalidStatePath: string;
};

const MCP_PROVIDER_FLOWS: Record<McpOAuthProvider, McpProviderFlow> = {
  linear: {
    start: startGoatLinearMcpOAuth,
    complete: completeGoatLinearMcpOAuth,
    verifyState: verifyGoatLinearMcpState,
    appendStatus: appendGoatLinearMcpStatus,
    deniedReason: "linear_denied",
    invalidStatePath: "/settings?integration=linear&setup=error&reason=invalid_state",
  },
  posthog: {
    start: startGoatPostHogMcpOAuth,
    complete: completeGoatPostHogMcpOAuth,
    verifyState: verifyGoatPostHogMcpState,
    appendStatus: appendGoatPostHogMcpStatus,
    deniedReason: "posthog_denied",
    invalidStatePath: "/settings/integrations?integration=posthog&setup=error&reason=invalid_state",
  },
  neon: {
    start: startGoatNeonMcpOAuth,
    complete: completeGoatNeonMcpOAuth,
    verifyState: verifyGoatNeonMcpState,
    appendStatus: appendGoatNeonMcpStatus,
    deniedReason: "neon_denied",
    invalidStatePath: "/settings/integrations?integration=neon&setup=error&reason=invalid_state",
  },
  latitude: {
    start: startGoatLatitudeMcpOAuth,
    complete: completeGoatLatitudeMcpOAuth,
    verifyState: verifyGoatLatitudeMcpState,
    appendStatus: appendGoatLatitudeMcpStatus,
    deniedReason: "latitude_denied",
    invalidStatePath:
      "/settings/integrations?integration=latitude&setup=error&reason=invalid_state",
  },
};

export function createMcpOAuthIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
}): McpOAuthIngressService {
  return {
    start: (provider, request) => handleStart(input, provider, request),
    callback: (provider, request) => handleCallback(input, provider, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier };

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
    return sessionRedirect(session, new URL(flow.invalidStatePath, getGoatAppUrl()));
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

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  flow: McpProviderFlow,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(flow.appendStatus(returnTo, status, reason), getGoatAppUrl()),
  );
}
