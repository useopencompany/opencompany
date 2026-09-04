import { afterEach, describe, expect, it, vi } from "vitest";
import { HUBSPOT_MCP_ENDPOINT_URL, hubspotMcpClientInformation } from "./hubspot-mcp";

describe("HubSpot MCP integration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds to HubSpot's hosted CRM MCP endpoint", () => {
    expect(HUBSPOT_MCP_ENDPOINT_URL).toBe("https://mcp.hubspot.com");
  });

  it("loads the MCP auth-app client credentials from server environment", () => {
    vi.stubEnv("OPENCOMPANY_HUBSPOT_MCP_CLIENT_ID", " hubspot-mcp-client ");
    vi.stubEnv("OPENCOMPANY_HUBSPOT_MCP_CLIENT_SECRET", " hubspot-mcp-secret ");

    expect(hubspotMcpClientInformation()).toEqual({
      client_id: "hubspot-mcp-client",
      client_secret: "hubspot-mcp-secret",
    });
  });

  it("fails closed when the MCP auth app is not configured", () => {
    vi.stubEnv("OPENCOMPANY_HUBSPOT_MCP_CLIENT_ID", "");
    vi.stubEnv("OPENCOMPANY_HUBSPOT_MCP_CLIENT_SECRET", "");

    expect(() => hubspotMcpClientInformation()).toThrow(
      "HubSpot MCP is not configured: OPENCOMPANY_HUBSPOT_MCP_CLIENT_ID is missing.",
    );
  });
});
