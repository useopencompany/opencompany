import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const TODOIST_MCP_ENDPOINT_URL = "https://ai.todoist.net/mcp";

// Todoist's protected-resource metadata advertises a single scope for the hosted MCP server, and
// its authorization server supports dynamic client registration, so no manually registered OAuth
// application or personal API token is needed.
const TODOIST_MCP_SCOPES = ["data:read_write"] as const;

const todoistMcpIntegration = createRemoteMcpIntegration({
  provider: "todoist",
  displayName: "Todoist",
  endpointUrl: TODOIST_MCP_ENDPOINT_URL,
  externalId: "todoist_mcp",
  storedScopes: TODOIST_MCP_SCOPES,
  authScope: TODOIST_MCP_SCOPES.join(" "),
});

export type TodoistMcpProviderState = RemoteMcpProviderState<"todoist">;

export const getTodoistMcpIntegrationState = todoistMcpIntegration.getState;
export const loadTodoistMcpWorkerConnection = todoistMcpIntegration.loadWorkerConnection;
export const startTodoistMcpOAuth = todoistMcpIntegration.start;
export const completeTodoistMcpOAuth = todoistMcpIntegration.complete;
export const verifyTodoistMcpState = todoistMcpIntegration.verifyState;
export const appendTodoistMcpStatus = todoistMcpIntegration.appendStatus;
