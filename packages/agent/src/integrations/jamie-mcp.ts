import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const JAMIE_MCP_ENDPOINT_URL = "https://mcp.meetjamie.ai/mcp";
export const JAMIE_MCP_EXTERNAL_ID = "jamie_mcp";

const jamieMcpIntegration = createRemoteMcpIntegration({
  provider: "jamie",
  displayName: "Jamie",
  endpointUrl: JAMIE_MCP_ENDPOINT_URL,
  externalId: JAMIE_MCP_EXTERNAL_ID,
  storedScopes: [],
  routeSegment: "jamie-mcp",
});

export type JamieProviderState = RemoteMcpProviderState<"jamie">;

export const getJamieMcpIntegrationState = jamieMcpIntegration.getState;
export const loadJamieMcpWorkerConnection = jamieMcpIntegration.loadWorkerConnection;
export const startJamieMcpOAuth = jamieMcpIntegration.start;
export const completeJamieMcpOAuth = jamieMcpIntegration.complete;
export const verifyJamieMcpState = jamieMcpIntegration.verifyState;
export const appendJamieMcpStatus = jamieMcpIntegration.appendStatus;
