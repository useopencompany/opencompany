import { createMCPClient } from "@ai-sdk/mcp";
import type { RemoteMcpGatewayDependencies } from "../actions/remote-mcp";

// Published at https://www.dash0.com/docs/api-reference, verified 2026-09-14.
// Region hints are identifiers, never URLs to which we forward credentials.
export const DASH0_MCP_REGIONS = {
  "aws-eu-west-1": "https://api.eu-west-1.aws.dash0.com/mcp",
  "aws-eu-central-1": "https://api.eu-central-1.aws.dash0.com/mcp",
  "aws-us-west-2": "https://api.us-west-2.aws.dash0.com/mcp",
  "gcp-europe-west4": "https://api.europe-west4.gcp.dash0.com/mcp",
} as const;

export const DASH0_MCP_ENDPOINT_URL = DASH0_MCP_REGIONS["aws-eu-west-1"];

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const reviewedOrigins = new Set(Object.values(DASH0_MCP_REGIONS).map((url) => new URL(url).origin));

// Each MCP client owns its routing state, so organizations cannot affect one another.
// OAuth discovery and refresh retain their original URLs and issuer. Only MCP traffic moves.
export function createDash0McpFetch(fetchRequest: Fetch = globalThis.fetch): Fetch {
  let endpoint: string = DASH0_MCP_ENDPOINT_URL;
  let routed = false;
  return async (input, init) => {
    const request = new Request(input, { ...init, redirect: "error" });
    const url = new URL(request.url);
    if (!reviewedOrigins.has(url.origin) || url.username || url.password || url.hash) {
      throw new Error("Dash0 requests must use a reviewed Dash0 endpoint.");
    }
    if (url.pathname !== "/mcp") return fetchRequest(request);
    if (request.url !== DASH0_MCP_ENDPOINT_URL) {
      throw new Error("Dash0 MCP requests must start at the reviewed package endpoint.");
    }
    const attempt = new Request(endpoint, request);
    const retry = attempt.clone();
    const response = await fetchRequest(attempt);
    if (response.status !== 421 || routed) return response;

    const mismatch = await response
      .clone()
      .json()
      .catch(() => null);
    if (
      mismatch?.error !== "organization_region_mismatch" ||
      mismatch.actual_region !== "aws-eu-west-1" ||
      typeof mismatch.expected_region !== "string"
    ) {
      return response;
    }
    if (!Object.hasOwn(DASH0_MCP_REGIONS, mismatch.expected_region)) {
      throw new Error(
        "Dash0 reported an organization region that opencompany does not support yet.",
      );
    }
    const target = DASH0_MCP_REGIONS[mismatch.expected_region as keyof typeof DASH0_MCP_REGIONS];
    if (target === endpoint) return response;
    // An established MCP session belongs to its original server. Start a fresh client instead
    // of replaying a session or a partially completed request against another region.
    if (request.headers.has("mcp-session-id")) {
      throw new Error(
        "Dash0's organization region changed. Refresh the plugin to start a new session.",
      );
    }
    await response.body?.cancel();
    endpoint = target;
    routed = true;
    return fetchRequest(new Request(endpoint, retry));
  };
}

export const createDash0McpClient: RemoteMcpGatewayDependencies["createClient"] = (input) =>
  createMCPClient({
    ...input,
    transport: { ...input.transport, fetch: createDash0McpFetch() },
  });
