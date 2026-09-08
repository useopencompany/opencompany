import { createRemoteMcpIntegration, type RemoteMcpProviderState } from "./remote-mcp-oauth";

export const SUPABASE_MCP_ENDPOINT_URL = "https://mcp.supabase.com/mcp";

const supabaseMcpIntegration = createRemoteMcpIntegration({
  provider: "supabase",
  displayName: "Supabase",
  endpointUrl: SUPABASE_MCP_ENDPOINT_URL,
  externalId: "supabase_mcp",
  storedScopes: [],
});

export type SupabaseMcpProviderState = RemoteMcpProviderState<"supabase">;

export const getSupabaseMcpIntegrationState = supabaseMcpIntegration.getState;
export const loadSupabaseMcpWorkerConnection = supabaseMcpIntegration.loadWorkerConnection;
export const startSupabaseMcpOAuth = supabaseMcpIntegration.start;
export const completeSupabaseMcpOAuth = supabaseMcpIntegration.complete;
export const verifySupabaseMcpState = supabaseMcpIntegration.verifyState;
export const appendSupabaseMcpStatus = supabaseMcpIntegration.appendStatus;
