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

  it("requires personal OAuth even when a workspace restricted key exists", async () => {
    mocks.db = fakeDb([[], [stripeStateRow()]]);
    const connection = await loadStripeMcpWorkerConnection({
      userWorkosId: "user_member",
      workspaceId: "workspace_1",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(STRIPE_MCP_ENDPOINT_URL).toBe("https://mcp.stripe.com");
    expect(connection).toEqual({ ok: false, reason: "not_connected" });
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });
  it("prefers OAuth over a saved workspace key", async () => {
    mocks.db = fakeDb([
      [
        {
          id: "gint_stripe_oauth",
          userWorkosId: "user_member",
          status: "connected",
        },
      ],
    ]);
    mocks.loadCredential.mockResolvedValueOnce({
      payload: {
        clientInformation: { client_id: "stripe-client" },
        tokens: {
          access_token: "oauth-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
        },
      },
    });
    const connection = await loadStripeMcpWorkerConnection({
      userWorkosId: "user_member",
      workspaceId: "workspace_1",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_stripe_oauth" });
    if (!connection.ok) throw new Error("Expected OAuth connection");
    expect(await connection.authProvider.tokens()).toMatchObject({ access_token: "oauth-token" });
    expect(mocks.loadCredential).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "oauth_token", userWorkosId: "user_member" }),
    );
    expect(mocks.db?.select).toHaveBeenCalledTimes(1);
  });

  it.each(["needs_reauth", "sync_failed", "connected"])(
    "does not fall back to a workspace key when OAuth is %s with missing credentials",
    async (status) => {
      mocks.db = fakeDb([[{ id: "gint_stripe_oauth", userWorkosId: "user_member", status }]]);
      mocks.loadCredential.mockResolvedValueOnce(null);
      await expect(
        loadStripeMcpWorkerConnection({
          userWorkosId: "user_member",
          workspaceId: "workspace_1",
          onAuthorizationRequired: () => {
            throw new Error("authorization required");
          },
        }),
      ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
      expect(mocks.db?.select).toHaveBeenCalledTimes(1);
    },
  );
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
