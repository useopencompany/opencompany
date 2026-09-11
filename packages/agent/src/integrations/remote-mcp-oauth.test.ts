import { auth } from "@ai-sdk/mcp";
import { beforeEach, expect, it, vi } from "vitest";
import { captureConnectionAddedAnalytics } from "./analytics";
import { createRemoteMcpIntegration } from "./remote-mcp-oauth";

vi.mock("@ai-sdk/mcp", () => ({ auth: vi.fn(async () => "AUTHORIZED") }));
vi.mock("@opencompany/db/integrations", () => ({
  loadIntegrationCredential: vi.fn(async () => null),
  markIntegrationStatus: vi.fn(),
  saveIntegrationCredential: vi.fn(),
}));
vi.mock("./analytics", () => ({ captureConnectionAddedAnalytics: vi.fn(async () => undefined) }));

beforeEach(() => vi.clearAllMocks());

it.each([true, false])(
  "reports OAuth connection success only after updating a row: %s",
  async (exists) => {
    const returning = vi.fn(async () => (exists ? [{ id: "connection_1" }] : []));
    const db = { update: () => ({ set: () => ({ where: () => ({ returning }) }) }) };
    const integration = createRemoteMcpIntegration({
      provider: "linear",
      displayName: "Linear",
      endpointUrl: "https://example.test/mcp",
      externalId: "linear_mcp",
      storedScopes: ["read"],
    });
    const result = integration.complete({
      userWorkosId: "user_1",
      integrationId: "connection_1",
      code: "code",
      state: "state",
      db,
    });
    if (exists) {
      await expect(result).resolves.toBeUndefined();
      expect(captureConnectionAddedAnalytics).toHaveBeenCalledExactlyOnceWith({
        userWorkosId: "user_1",
        connectionId: "connection_1",
        provider: "linear",
      });
    } else {
      await expect(result).rejects.toThrow("connection no longer exists");
      expect(captureConnectionAddedAnalytics).not.toHaveBeenCalled();
    }
    expect(auth).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledOnce();
  },
);
