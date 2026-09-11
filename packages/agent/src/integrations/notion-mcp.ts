import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const NOTION_MCP_ENDPOINT_URL = "https://mcp.notion.com/mcp";

const NOTION_MCP_SCOPES = ["default"] as const;

const notionMcpIntegration = createRemoteMcpIntegration({
  provider: "notion",
  displayName: "Notion",
  endpointUrl: NOTION_MCP_ENDPOINT_URL,
  externalId: "notion_mcp",
  storedScopes: NOTION_MCP_SCOPES,
  authScope: NOTION_MCP_SCOPES.join(" "),
});

export type NotionMcpProviderState = RemoteMcpProviderState<"notion">;

export const getNotionMcpIntegrationState = notionMcpIntegration.getState;
export const loadNotionMcpWorkerConnection = notionMcpIntegration.loadWorkerConnection;
export const startNotionMcpOAuth = notionMcpIntegration.start;
export const completeNotionMcpOAuth = notionMcpIntegration.complete;
export const verifyNotionMcpState = notionMcpIntegration.verifyState;
export const appendNotionMcpStatus = notionMcpIntegration.appendStatus;
