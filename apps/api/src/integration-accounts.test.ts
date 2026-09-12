import {
  connectConvexMcpIntegration,
  getConvexIntegrationState,
  validateConvexApiKey,
} from "@opencompany/agent/integrations/convex-mcp";
import {
  connectGranolaIntegration,
  getGranolaIntegrationState,
  validateGranolaApiKey,
} from "@opencompany/agent/integrations/granola";
import {
  connectRenderMcpIntegration,
  getRenderIntegrationState,
  validateRenderApiKey,
} from "@opencompany/agent/integrations/render-mcp";
import {
  connectStripeIntegration,
  disconnectStripeIntegration,
  validateStripeRestrictedApiKey,
} from "@opencompany/agent/integrations/stripe";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import type { Actor } from "@opencompany/core";
import {
  applyIntegrationCapabilityMode,
  disconnectPersonalIntegration,
} from "@opencompany/db/integrations";
import { ensureWikiSourceEnabledOnConnect } from "@opencompany/db/wiki-sources";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationAccountService } from "./integration-accounts";
import type { RunnerClient } from "./runner-client";

vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyIntegrationCapabilityMode: vi.fn(async () => undefined),
  disconnectPersonalIntegration: vi.fn(async () => true),
  loadIntegrationCredential: vi.fn(async () => null),
}));

vi.mock("@opencompany/db/wiki-sources", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureWikiSourceEnabledOnConnect: vi.fn(async () => true),
}));

vi.mock("@opencompany/agent/integrations/granola", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateGranolaApiKey: vi.fn(),
  connectGranolaIntegration: vi.fn(async () => ({ integrationId: "gint_granola" })),
  getGranolaIntegrationState: vi.fn(async () => ({
    provider: "granola" as const,
    connected: true,
    status: "connected" as const,
    integrationId: "gint_granola",
    accountEmail: "sam@example.com",
    accountName: "Sam",
    statusReason: null,
  })),
}));

vi.mock("@opencompany/agent/integrations/convex-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateConvexApiKey: vi.fn(),
  connectConvexMcpIntegration: vi.fn(async () => ({ integrationId: "gint_convex" })),
  getConvexIntegrationState: vi.fn(async () => ({
    provider: "convex" as const,
    connected: true,
    status: "connected" as const,
    integrationId: "gint_convex",
    accountName: "Acme",
    statusReason: null,
    capabilityModes: {},
    toolModes: {},
  })),
}));
vi.mock("@opencompany/agent/integrations/render-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateRenderApiKey: vi.fn(),
  connectRenderMcpIntegration: vi.fn(async () => ({ integrationId: "gint_render" })),
  getRenderIntegrationState: vi.fn(async () => ({
    provider: "render" as const,
    connected: true,
    status: "connected" as const,
    integrationId: "gint_render",
    accountName: "Acme",
    statusReason: null,
    capabilityModes: {},
    toolModes: {},
  })),
}));

vi.mock("@opencompany/agent/integrations/stripe", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateStripeRestrictedApiKey: vi.fn(),
  connectStripeIntegration: vi.fn(),
  getStripeIntegrationState: vi.fn(),
  disconnectStripeIntegration: vi.fn(async () => false),
}));

vi.mock("@opencompany/agent/integrations/analytics", () => ({
  captureConnectionAddedAnalytics: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductServerEvent: vi.fn(async () => undefined),
}));

const admin: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
};
const member: Actor = { ...admin, role: "member" };

// Chainable fake for the service's direct drizzle queries. Each select()
// consumes the next queued row set, whether the chain ends in limit() or is
// awaited directly.
function fakeDb(queues: unknown[][] = []) {
  let call = 0;
  const select = vi.fn(() => {
    const rows = queues[call++] ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = async () => rows;
    chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  });
  return { select, execute: vi.fn(async () => []) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "test-pairing-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("integration account service", () => {
  it("lists only credential-free personal account fields", async () => {
    const service = createIntegrationAccountService({
      db: fakeDb([
        [
          {
            id: "gint_gmail",
            provider: "gmail",
            workspaceId: null,
            externalId: "google_subject",
            accountEmail: "ada@example.com",
            accountName: "Ada",
            connectionLabel: "Personal",
            statusReason: null,
            status: "connected",
            scopes: ["gmail.readonly"],
            capabilityModes: { read: "on" },
            lastSyncedAt: new Date("2026-09-10T12:00:00.000Z"),
          },
          {
            id: "gint_linear_mcp",
            provider: "linear",
            workspaceId: null,
            externalId: "linear_mcp",
            accountEmail: null,
            accountName: "Acme",
            connectionLabel: null,
            statusReason: null,
            status: "connected",
            scopes: [],
            capabilityModes: {},
          },
          {
            id: "gint_betterstack_mcp",
            provider: "betterstack",
            workspaceId: null,
            externalId: "betterstack_mcp",
            accountEmail: "ada@example.com",
            accountName: "Ada's team",
            connectionLabel: "Better Stack tool access",
            statusReason: null,
            status: "connected",
            scopes: ["read", "write"],
            capabilityModes: { read: "on", query: "ask", write: "ask" },
          },
          {
            id: "gint_fathom_legacy",
            provider: "fathom",
            workspaceId: null,
            externalId: "fathom:user_1",
            accountEmail: null,
            accountName: "Fathom",
            connectionLabel: "Fathom",
            statusReason: null,
            status: "connected",
            scopes: [],
            capabilityModes: {},
          },
          {
            id: "gint_fathom_mcp",
            provider: "fathom",
            workspaceId: null,
            externalId: "fathom_mcp",
            accountEmail: null,
            accountName: "Fathom",
            connectionLabel: "Fathom",
            statusReason: null,
            status: "connected",
            scopes: ["mcp"],
            capabilityModes: { query: "ask" },
          },
        ],
      ]),
    });

    await expect(service.list(member)).resolves.toEqual([
      {
        integrationId: "gint_gmail",
        provider: "gmail",
        status: "connected",
        connected: true,
        accountEmail: "ada@example.com",
        accountName: "Ada",
        connectionLabel: "Personal",
        statusReason: null,
        scopes: ["gmail.readonly"],
        capabilityModes: { read: "on" },
        connectedAt: "2026-09-10T12:00:00.000Z",
      },
      {
        integrationId: "gint_fathom_mcp",
        provider: "fathom",
        status: "connected",
        connected: true,
        accountEmail: null,
        accountName: "Fathom",
        connectionLabel: "Fathom",
        statusReason: null,
        scopes: ["mcp"],
        capabilityModes: { query: "ask" },
        connectedAt: null,
      },
      {
        integrationId: "gint_betterstack_mcp",
        provider: "betterstack",
        status: "connected",
        connected: true,
        accountEmail: "ada@example.com",
        accountName: "Ada's team",
        connectionLabel: "Better Stack tool access",
        statusReason: null,
        scopes: ["read", "write"],
        capabilityModes: { read: "on", query: "ask", write: "ask" },
        connectedAt: null,
      },
    ]);
  });

  it("gates usage reads to the personal connection owner", async () => {
    const service = createIntegrationAccountService({ db: fakeDb([[]]) });
    await expect(service.getUsage(member, "gint_x")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      message: "Only the connection owner can manage this account.",
    });
  });

  it("counts affected brain sources for the owner", async () => {
    const db = fakeDb([[{ id: "gint_x" }], [{ count: 4 }]]);
    const service = createIntegrationAccountService({ db });
    await expect(service.getUsage(member, "gint_x")).resolves.toEqual({
      affectedBrainSourceCount: 4,
    });
  });

  it("does not report retired Slack source rows as active account usage", async () => {
    const service = createIntegrationAccountService({
      db: fakeDb([[{ id: "gint_slack", provider: "slack" }]]),
    });

    await expect(service.getUsage(member, "gint_slack")).resolves.toEqual({
      affectedBrainSourceCount: 0,
    });
  });

  it("reports a non-owned disconnect with the retired owner-only copy", async () => {
    vi.mocked(disconnectPersonalIntegration).mockResolvedValueOnce(false);
    const service = createIntegrationAccountService({
      db: fakeDb([[{ id: "gint_x", provider: "x_account" }]]),
    });
    await expect(service.disconnect(member, "gint_x")).rejects.toMatchObject({
      status: 404,
      message: "Only the connection owner can manage this account.",
    });
    expect(captureProductServerEvent).not.toHaveBeenCalled();
  });

  it("runs the shared disconnect for the owner", async () => {
    const service = createIntegrationAccountService({
      db: fakeDb([[{ id: "gint_x", provider: "x_account" }]]),
    });
    await expect(service.disconnect(member, "gint_x")).resolves.toBeUndefined();
    expect(disconnectPersonalIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", integrationId: "gint_x" }),
    );
    expect(captureProductServerEvent).toHaveBeenCalledWith("connection_removed", "user_1", {
      workspace_id: "workspace_1",
      provider: "x_account",
      connection_id: "gint_x",
    });
  });

  it("validates capability modes and ids before touching the connection", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(
      service.setCapabilityMode(member, "gint_x", "write", "sometimes"),
    ).rejects.toMatchObject({ status: 400, message: "Unknown permission mode." });
    await expect(
      service.setCapabilityMode(member, "gint_x", "unknown-capability", "on"),
    ).rejects.toMatchObject({ status: 400, message: "Unknown permission mode." });
    expect(applyIntegrationCapabilityMode).not.toHaveBeenCalled();
  });

  it("rejects capability updates for providers without that capability", async () => {
    const db = fakeDb([
      [
        {
          id: "gint_x",
          provider: "granola",
          userWorkosId: "user_1",
          workspaceId: null,
        },
      ],
    ]);
    const service = createIntegrationAccountService({ db });
    await expect(service.setCapabilityMode(member, "gint_x", "write", "on")).rejects.toMatchObject({
      status: 400,
      message: "This integration has no such permission.",
    });
  });

  it("applies a valid capability mode override", async () => {
    const db = fakeDb([
      [
        {
          id: "gint_x",
          provider: "gmail",
          userWorkosId: "user_1",
          workspaceId: null,
        },
      ],
    ]);
    const service = createIntegrationAccountService({ db });
    await expect(
      service.setCapabilityMode(member, "gint_x", "write", "ask"),
    ).resolves.toBeUndefined();
    expect(applyIntegrationCapabilityMode).toHaveBeenCalledWith(
      expect.objectContaining({ integrationIds: ["gint_x"], capabilityId: "write", mode: "ask" }),
    );
  });

  it.each(["read", "query", "write"])(
    "updates Supabase %s permission through account settings",
    async (capabilityId) => {
      const db = fakeDb([
        [
          {
            id: "gint_x",
            provider: "supabase",
            userWorkosId: "user_1",
            workspaceId: null,
          },
        ],
      ]);
      const service = createIntegrationAccountService({ db });
      await expect(
        service.setCapabilityMode(member, "gint_x", capabilityId, "ask"),
      ).resolves.toBeUndefined();
      expect(applyIntegrationCapabilityMode).toHaveBeenCalledWith(
        expect.objectContaining({ integrationIds: ["gint_x"], capabilityId, mode: "ask" }),
      );
    },
  );
  it.each(["read", "query", "write", "draft"])(
    "updates Resend %s permission through account settings",
    async (capabilityId) => {
      const db = fakeDb([
        [
          {
            id: "gint_x",
            provider: "resend",
            userWorkosId: "user_1",
            workspaceId: null,
          },
        ],
      ]);
      const service = createIntegrationAccountService({ db });
      await expect(
        service.setCapabilityMode(member, "gint_x", capabilityId, "ask"),
      ).resolves.toBeUndefined();
      expect(applyIntegrationCapabilityMode).toHaveBeenCalledWith(
        expect.objectContaining({ integrationIds: ["gint_x"], capabilityId, mode: "ask" }),
      );
    },
  );

  it("rejects workspace-owned permission changes for both members and admins", async () => {
    const row = {
      id: "gint_stripe",
      provider: "stripe",
      userWorkosId: "user_admin",
      workspaceId: "workspace_1",
    };
    for (const actor of [member, admin]) {
      const service = createIntegrationAccountService({ db: fakeDb([[row]]) });
      await expect(
        service.setCapabilityMode(actor, "gint_stripe", "query", "on"),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(applyIntegrationCapabilityMode).not.toHaveBeenCalled();
  });

  it("forwards standing action permission changes to the execution owner", async () => {
    const postJson = vi.fn(async () => ({ changed: true }));
    const runner = {
      requestJson: vi.fn(),
      postJson: postJson as RunnerClient["postJson"],
    } as RunnerClient;
    const service = createIntegrationAccountService({ db: fakeDb(), runner });

    await expect(service.alwaysAllowAction(member, " gmail.send_email ")).resolves.toBeUndefined();
    expect(postJson).toHaveBeenCalledWith(
      "/internal/goat/actions/always-allow",
      {
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        actionId: "gmail.send_email",
      },
      { errorFormat: "error-message" },
    );
  });

  it("fails closed when the execution owner is unavailable", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.alwaysAllowAction(member, "gmail.send_email")).rejects.toMatchObject({
      status: 503,
      message: "The action permission service is unavailable.",
    });
  });

  it("keeps the retired key-format copy for provider connects", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.connectAttio(member, "short")).rejects.toMatchObject({
      message: "This does not look like an Attio API key. Check it and try again.",
    });
    await expect(service.connectFathom(member, "nope")).rejects.toMatchObject({
      message: "This does not look like a Fathom API key. Check it and try again.",
    });
    await expect(service.connectGranola(member, "not-a-granola-key")).rejects.toMatchObject({
      message: "Granola API keys start with grn_. Check the key and try again.",
    });
    await expect(service.connectRender(member, "not-a-render-key")).rejects.toMatchObject({
      message: "Render API keys start with rnd_. Check the key and try again.",
    });
  });

  it("connects Granola with the trimmed key and returns the refreshed state", async () => {
    vi.mocked(validateGranolaApiKey).mockResolvedValueOnce({
      ok: true,
      accountEmail: "sam@example.com",
      accountName: "Sam",
    });
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.connectGranola(member, "  grn_valid_key_12345  ")).resolves.toMatchObject({
      provider: "granola",
      connected: true,
      integrationId: "gint_granola",
    });
    expect(connectGranolaIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", apiKey: "grn_valid_key_12345" }),
    );
    expect(ensureWikiSourceEnabledOnConnect).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      provider: "granola",
      integrationId: "gint_granola",
      userWorkosId: "user_1",
      createdByWorkosId: "user_1",
      db: expect.anything(),
    });
    expect(getGranolaIntegrationState).toHaveBeenCalled();
  });

  it("surfaces provider-rejected keys with the validator's message", async () => {
    vi.mocked(validateGranolaApiKey).mockResolvedValueOnce({
      ok: false,
      error: "Granola rejected this API key. Check it and try again.",
    });
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.connectGranola(member, "grn_valid_key_12345")).rejects.toMatchObject({
      status: 400,
      message: "Granola rejected this API key. Check it and try again.",
    });
  });

  it("connects Render with a validated key and refreshes plugin discovery", async () => {
    vi.mocked(validateRenderApiKey).mockResolvedValueOnce({
      ok: true,
      owner: { id: "tea_123", name: "Acme", email: "founder@example.com" },
    });
    const refreshRenderPluginRegistrations = vi.fn(async () => undefined);
    const service = createIntegrationAccountService({
      db: fakeDb(),
      refreshRenderPluginRegistrations,
    });

    await expect(service.connectRender(member, "  rnd_abcdefgh12345678  ")).resolves.toMatchObject({
      provider: "render",
      connected: true,
      integrationId: "gint_render",
    });
    expect(connectRenderMcpIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        apiKey: "rnd_abcdefgh12345678",
        owner: { id: "tea_123", name: "Acme", email: "founder@example.com" },
      }),
    );
    expect(refreshRenderPluginRegistrations).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(getRenderIntegrationState).toHaveBeenCalled();
  });

  it.each([member, admin])("retires shared Stripe key creation for $role", async (actor) => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.connectStripe(actor, "rk_test_x".padEnd(40, "a"))).rejects.toMatchObject({
      status: 410,
      message:
        "Workspace Stripe keys are retired. Connect your personal Stripe account in Plugins settings.",
    });
    expect(validateStripeRestrictedApiKey).not.toHaveBeenCalled();
    expect(connectStripeIntegration).not.toHaveBeenCalled();
  });

  it("requires admin access to remove a retired shared Stripe key", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.disconnectStripe(member)).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can manage the Stripe integration.",
    });
  });

  it("reports successful workspace Stripe disconnection", async () => {
    vi.mocked(disconnectStripeIntegration).mockResolvedValueOnce(true);
    const service = createIntegrationAccountService({ db: fakeDb() });
    await service.disconnectStripe(admin);
    expect(captureProductServerEvent).toHaveBeenCalledExactlyOnceWith(
      "connection_removed",
      "user_1",
      {
        workspace_id: "workspace_1",
        provider: "stripe",
      },
    );
  });

  it("reports when no retired Stripe key exists", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    vi.mocked(disconnectStripeIntegration).mockResolvedValueOnce(false);
    await expect(service.disconnectStripe(admin)).rejects.toMatchObject({
      status: 404,
      message: "Stripe is not connected.",
    });
  });
});

describe("Convex connection", () => {
  it("validates a scoped key before storage and refreshes plugin discovery", async () => {
    const refresh = vi.fn(async () => undefined);
    const service = createIntegrationAccountService({
      db: {},
      refreshConvexPluginRegistrations: refresh,
    });
    vi.mocked(validateConvexApiKey).mockResolvedValue({ ok: true, deployment: "happy-animal-123" });
    const state = await service.connectConvex(member, " dev:happy-animal-123|abcdefgh ");
    expect(connectConvexMcpIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: member.userId,
        apiKey: "dev:happy-animal-123|abcdefgh",
        deployment: "happy-animal-123",
      }),
    );
    expect(refresh).toHaveBeenCalledWith({
      userWorkosId: member.userId,
      workspaceId: member.workspaceId,
    });
    expect(state.provider).toBe("convex");
    expect(JSON.stringify(state)).not.toContain("abcdefgh");
  });
  it("rejects project tokens and rejected credentials without storage", async () => {
    vi.mocked(connectConvexMcpIntegration).mockClear();
    const service = createIntegrationAccountService({ db: {} });
    await expect(
      service.connectConvex(member, "project:team:project|abcdefgh"),
    ).rejects.toMatchObject({ status: 400 });
    vi.mocked(validateConvexApiKey).mockResolvedValue({ ok: false, error: "Key rejected" });
    await expect(
      service.connectConvex(member, "dev:happy-animal-123|abcdefgh"),
    ).rejects.toMatchObject({ status: 400 });
    expect(connectConvexMcpIntegration).not.toHaveBeenCalled();
  });
});
