import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  loadCredential: vi.fn(),
  saveCredential: vi.fn(),
}));
vi.mock("@opencompany/db/client", () => ({ getDb: mocks.getDb }));
vi.mock("@opencompany/db/integrations", () => ({
  loadIntegrationCredential: mocks.loadCredential,
  saveIntegrationCredential: mocks.saveCredential,
  markIntegrationStatus: vi.fn(),
}));
vi.mock("./analytics", () => ({ captureConnectionAddedAnalytics: vi.fn() }));

import { connectConvexMcpIntegration, loadConvexMcpWorkerConnection } from "./convex-mcp";
import { verifyConvexMcpTicket } from "./convex-mcp-ticket";

const apiKey = "dev:happy-animal-123|fakekey123";
const connectionVersion = "connection-version-1";
const workerInput = {
  userWorkosId: "u1",
  workspaceId: "w1",
  registrationId: "r1",
  operation: { type: "tools/list" } as const,
  onAuthorizationRequired: (): never => {
    throw new Error("authorization required");
  },
};

describe("Convex credential versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("API_INTERNAL_TOKEN", "test-secret");
    const query = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "i1", status: "connected" }]),
    };
    mocks.getDb.mockReturnValue({ select: () => query });
    mocks.loadCredential.mockResolvedValue({ payload: { apiKey, connectionVersion } });
    mocks.saveCredential.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("stores a fresh version with the encrypted credential on every connection", async () => {
    const insert = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "i1" }]),
    };
    const input = {
      userWorkosId: "u1",
      apiKey,
      deployment: "happy-animal-123",
      db: { insert: () => insert },
    };
    await connectConvexMcpIntegration(input);
    await connectConvexMcpIntegration(input);
    const versions = mocks.saveCredential.mock.calls.map(([saved]) => {
      expect(saved).toMatchObject({ integrationId: "i1", payload: { apiKey } });
      expect(saved.payload.connectionVersion).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      return saved.payload.connectionVersion;
    });
    expect(versions[0]).not.toBe(versions[1]);
  });

  it("mints a scoped ticket containing the saved version without the deploy key", async () => {
    const connection = await loadConvexMcpWorkerConnection(workerInput);
    if (!connection.ok) throw new Error("Expected a connected Convex account.");
    const tokens = await connection.authProvider.tokens();
    const payload = verifyConvexMcpTicket({
      ticket: tokens?.access_token ?? "",
      secret: "test-secret",
    });
    expect(payload).toMatchObject({
      userWorkosId: "u1",
      workspaceId: "w1",
      integrationId: "i1",
      registrationId: "r1",
      operation: workerInput.operation,
      connectionVersion,
    });
    expect(JSON.stringify(payload)).not.toContain(apiKey);
  });

  it.each([undefined, "", 42, "x".repeat(129)])(
    "requires reconnection for an invalid saved version: %j",
    async (invalidVersion) => {
      mocks.loadCredential.mockResolvedValue({
        payload: { apiKey, connectionVersion: invalidVersion },
      });
      await expect(loadConvexMcpWorkerConnection(workerInput)).resolves.toEqual({
        ok: false,
        reason: "needs_reauth",
      });
    },
  );
});
