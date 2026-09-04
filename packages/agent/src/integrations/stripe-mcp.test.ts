import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as ReturnType<typeof fakeDb> | null,
  loadCredential: vi.fn(),
  markStatus: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => mocks.db,
}));

vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntegrationCredential: mocks.loadCredential,
  markIntegrationStatus: mocks.markStatus,
}));

import { loadStripeMcpWorkerConnection, STRIPE_MCP_ENDPOINT_URL } from "./stripe";

describe("Stripe MCP bearer connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db = null;
  });

  it("injects the saved restricted key as a server-side bearer token", async () => {
    const apiKey = `rk_live_${"a".repeat(24)}`;
    mocks.db = fakeDb([
      [stripeStateRow()],
      [
        {
          id: "gint_stripe",
          userWorkosId: "user_admin",
          externalId: "acct_123",
          accountName: "Acme",
          status: "connected",
        },
      ],
    ]);
    mocks.loadCredential.mockResolvedValueOnce({
      payload: {
        apiKey,
        accountId: "acct_123",
        livemode: true,
        connectedAt: "2026-09-04T00:00:00.000Z",
      },
    });

    const connection = await loadStripeMcpWorkerConnection({
      userWorkosId: "user_member",
      workspaceId: "workspace_1",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });

    expect(STRIPE_MCP_ENDPOINT_URL).toBe("https://mcp.stripe.com");
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_stripe" });
    if (!connection.ok) throw new Error("Expected a connected Stripe MCP worker.");
    expect(await connection.authProvider.tokens()).toEqual({
      access_token: apiKey,
      token_type: "Bearer",
    });
    expect(mocks.markStatus).not.toHaveBeenCalled();
  });

  it("fails closed and marks the connection for reauthorization when the credential is invalid", async () => {
    mocks.db = fakeDb([
      [stripeStateRow()],
      [
        {
          id: "gint_stripe",
          userWorkosId: "user_admin",
          externalId: "acct_123",
          accountName: "Acme",
          status: "connected",
        },
      ],
    ]);
    mocks.loadCredential.mockResolvedValueOnce({ payload: { apiKey: "sk_live_not_allowed" } });

    await expect(
      loadStripeMcpWorkerConnection({
        userWorkosId: "user_member",
        workspaceId: "workspace_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
    expect(mocks.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_admin",
        integrationId: "gint_stripe",
        provider: "stripe",
        status: "needs_reauth",
      }),
    );
  });
});

function stripeStateRow() {
  return {
    id: "gint_stripe",
    status: "connected",
    accountName: "Acme",
    accountType: "stripe_live_restricted_key",
    statusReason: null,
    capabilityModes: {},
    toolModes: {},
  };
}

function fakeDb(queues: unknown[][]) {
  let call = 0;
  return {
    select: vi.fn(() => {
      const rows = queues[call++] ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = async () => rows;
      return chain;
    }),
  };
}
