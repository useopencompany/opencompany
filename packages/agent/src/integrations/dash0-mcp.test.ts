import { describe, expect, it, vi } from "vitest";

const loadWorkerConnection = vi.hoisted(() => vi.fn());
vi.mock("./remote-mcp-oauth", () => ({
  createRemoteMcpIntegration: vi.fn(() => ({ loadWorkerConnection })),
}));

import { loadDash0McpWorkerConnection } from "./dash0-mcp";
import { createDash0McpClient } from "./dash0-mcp-transport";
import { createRemoteMcpIntegration } from "./remote-mcp-oauth";

describe("Dash0 worker connection", () => {
  it("preserves existing OAuth connections and supplies regional routing to the gateway", async () => {
    expect(createRemoteMcpIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "dash0_mcp_eu_west_1" }),
    );
    const connection = { ok: true, integrationId: "existing-connection", authProvider: {} };
    loadWorkerConnection.mockResolvedValueOnce(connection);
    const input = {
      userWorkosId: "user",
      onAuthorizationRequired: () => {
        throw new Error("Auth required");
      },
    };
    await expect(loadDash0McpWorkerConnection(input)).resolves.toEqual({
      ...connection,
      createClient: createDash0McpClient,
    });
    expect(loadWorkerConnection).toHaveBeenCalledWith(input);
    loadWorkerConnection.mockResolvedValueOnce({ ok: false, reason: "needs_reauth" });
    await expect(loadDash0McpWorkerConnection(input)).resolves.toEqual({
      ok: false,
      reason: "needs_reauth",
    });
  });
});
