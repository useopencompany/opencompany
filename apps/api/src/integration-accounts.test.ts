import {
  connectImessageIntegration,
  getImessageIntegrationState,
  hashImessagePairingCode,
} from "@opencompany/agent/imessage/connect";
import {
  connectGranolaIntegration,
  getGranolaIntegrationState,
  validateGranolaApiKey,
} from "@opencompany/agent/integrations/granola";
import { saveJamieWebhookApiKey } from "@opencompany/agent/integrations/jamie";
import { disconnectStripeIntegration } from "@opencompany/agent/integrations/stripe";
import type { Actor } from "@opencompany/core";
import {
  consumeImessageChallenge,
  getImessagePairingChallenge,
  incrementImessageChallengeAttempts,
  upsertImessagePairingChallenge,
} from "@opencompany/db/imessage";
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

vi.mock("@opencompany/db/imessage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImessagePairingChallenge: vi.fn(async () => null),
  upsertImessagePairingChallenge: vi.fn(async () => undefined),
  incrementImessageChallengeAttempts: vi.fn(async () => undefined),
  consumeImessageChallenge: vi.fn(async () => undefined),
  recordImessageSend: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/wiki-sources", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureWikiSourceEnabledOnConnect: vi.fn(async () => true),
}));

vi.mock("@opencompany/agent/imessage/connect", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectImessageIntegration: vi.fn(async () => ({ integrationId: "gint_imsg" })),
  getImessageIntegrationState: vi.fn(async () => ({
    provider: "imessage" as const,
    connected: true,
    status: "connected" as const,
    integrationId: "gint_imsg",
    phoneE164: "+14155551234",
    statusReason: null,
  })),
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

vi.mock("@opencompany/agent/integrations/jamie", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createOrResetJamieWebhookEndpoint: vi.fn(),
  saveJamieWebhookApiKey: vi.fn(),
}));

vi.mock("@opencompany/agent/integrations/stripe", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateStripeRestrictedApiKey: vi.fn(),
  connectStripeIntegration: vi.fn(),
  getStripeIntegrationState: vi.fn(),
  disconnectStripeIntegration: vi.fn(async () => false),
}));

vi.mock("@opencompany/agent/integrations/analytics", () => ({
  captureIntegrationAddedAnalytics: vi.fn(async () => undefined),
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

  it("reports a non-owned disconnect with the retired owner-only copy", async () => {
    vi.mocked(disconnectPersonalIntegration).mockResolvedValueOnce(false);
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.disconnect(member, "gint_x")).rejects.toMatchObject({
      status: 404,
      message: "Only the connection owner can manage this account.",
    });
  });

  it("runs the shared disconnect for the owner", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.disconnect(member, "gint_x")).resolves.toBeUndefined();
    expect(disconnectPersonalIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", integrationId: "gint_x" }),
    );
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
    const db = fakeDb([[{ id: "gint_x" }], [{ provider: "granola" }]]);
    const service = createIntegrationAccountService({ db });
    await expect(service.setCapabilityMode(member, "gint_x", "write", "on")).rejects.toMatchObject({
      status: 400,
      message: "This integration has no such permission.",
    });
  });

  it("applies a valid capability mode override", async () => {
    const db = fakeDb([[{ id: "gint_x" }], [{ provider: "gmail" }]]);
    const service = createIntegrationAccountService({ db });
    await expect(
      service.setCapabilityMode(member, "gint_x", "write", "ask"),
    ).resolves.toBeUndefined();
    expect(applyIntegrationCapabilityMode).toHaveBeenCalledWith(
      expect.objectContaining({ integrationIds: ["gint_x"], capabilityId: "write", mode: "ask" }),
    );
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

  it("requires the preference toggle and a configured provider before pairing", async () => {
    const service = createIntegrationAccountService({
      db: fakeDb([[{ imessageEnabled: false }]]),
      resolveImessageProvider: () => null,
    });
    await expect(service.startImessagePairing(member, "+14155551234")).rejects.toMatchObject({
      message: "Enable iMessage notifications in Preferences first.",
    });

    const unconfigured = createIntegrationAccountService({
      db: fakeDb([[{ imessageEnabled: true }]]),
      resolveImessageProvider: () => null,
    });
    await expect(unconfigured.startImessagePairing(member, "+14155551234")).rejects.toMatchObject({
      status: 503,
      message: "iMessage sending is not configured on this environment.",
    });
  });

  it("sends a pairing code and records the delivery", async () => {
    const send = vi.fn(async () => ({ ok: true as const, providerMessageId: null }));
    const service = createIntegrationAccountService({
      db: fakeDb([[{ imessageEnabled: true }]]),
      resolveImessageProvider: () => ({ name: "log", send }),
      generatePairingCode: () => "123456",
    });
    await expect(
      service.startImessagePairing(member, "+1 (415) 555-1234"),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({
      to: "+14155551234",
      text: "Your opencompany verification code is 123456. It expires in 10 minutes.",
    });
    expect(upsertImessagePairingChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", phoneE164: "+14155551234" }),
      expect.anything(),
    );
  });

  it("throttles pairing resends inside the cooldown window", async () => {
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.mocked(getImessagePairingChallenge).mockResolvedValueOnce({
      id: "chal_1",
      phoneE164: "+14155551234",
      codeHash: "hash",
      attemptCount: 0,
      consumedAt: null,
      createdAt: new Date(now.getTime() - 5_000),
      expiresAt: new Date(now.getTime() + 60_000),
    } as never);
    const service = createIntegrationAccountService({
      db: fakeDb([[{ imessageEnabled: true }]]),
      resolveImessageProvider: () => ({ name: "log", send: vi.fn() as never }),
      now: () => now,
    });
    await expect(service.startImessagePairing(member, "+14155551234")).rejects.toMatchObject({
      status: 429,
      message: "A code was just sent. Wait a moment before requesting another.",
    });
  });

  it("confirms a matching pairing code and connects the number", async () => {
    const now = new Date("2026-08-13T08:00:00.000Z");
    const codeHash = hashImessagePairingCode({
      code: "654321",
      userWorkosId: "user_1",
      phoneE164: "+14155551234",
    });
    vi.mocked(getImessagePairingChallenge).mockResolvedValueOnce({
      id: "chal_1",
      phoneE164: "+14155551234",
      codeHash,
      attemptCount: 0,
      consumedAt: null,
      createdAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 60_000),
    } as never);
    const service = createIntegrationAccountService({ db: fakeDb(), now: () => now });
    await expect(service.confirmImessagePairing(member, "654321")).resolves.toMatchObject({
      provider: "imessage",
      connected: true,
      phoneE164: "+14155551234",
    });
    expect(consumeImessageChallenge).toHaveBeenCalledWith("chal_1", expect.anything());
    expect(connectImessageIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", phoneE164: "+14155551234" }),
    );
  });

  it("counts down remaining attempts on a mismatched code", async () => {
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.mocked(getImessagePairingChallenge).mockResolvedValueOnce({
      id: "chal_1",
      phoneE164: "+14155551234",
      codeHash: hashImessagePairingCode({
        code: "654321",
        userWorkosId: "user_1",
        phoneE164: "+14155551234",
      }),
      attemptCount: 3,
      consumedAt: null,
      createdAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 60_000),
    } as never);
    const service = createIntegrationAccountService({ db: fakeDb(), now: () => now });
    await expect(service.confirmImessagePairing(member, "111111")).rejects.toMatchObject({
      status: 400,
      message: "That code doesn't match. 1 attempt left.",
    });
    expect(incrementImessageChallengeAttempts).toHaveBeenCalledWith("chal_1", expect.anything());
    expect(getImessageIntegrationState).not.toHaveBeenCalled();
  });

  it("admin-gates the workspace-scoped Stripe and Jamie commands", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.connectStripe(member, "rk_test_x".padEnd(40, "a"))).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can manage the Stripe integration.",
    });
    await expect(service.disconnectStripe(member)).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can manage the Stripe integration.",
    });
    await expect(service.createOrResetJamieWebhookEndpoint(member)).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can manage the Jamie integration.",
    });
    await expect(service.saveJamieWebhookApiKey(member, "sk_x")).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can manage the Jamie integration.",
    });
  });

  it("keeps the retired Stripe key-format and not-connected copy", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.connectStripe(admin, "sk_live_notrestricted")).rejects.toMatchObject({
      message:
        "Use a restricted Stripe key beginning with rk_test_ or rk_live_. Unrestricted sk_ keys are not accepted.",
    });
    vi.mocked(disconnectStripeIntegration).mockResolvedValueOnce(false);
    await expect(service.disconnectStripe(admin)).rejects.toMatchObject({
      status: 404,
      message: "Stripe is not connected.",
    });
  });

  it("surfaces Jamie lib validation errors verbatim like the retired action", async () => {
    vi.mocked(saveJamieWebhookApiKey).mockRejectedValueOnce(
      new Error("Create a Jamie webhook endpoint before saving the API key."),
    );
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.saveJamieWebhookApiKey(admin, "sk_x")).rejects.toMatchObject({
      status: 400,
      message: "Create a Jamie webhook endpoint before saving the API key.",
    });
  });

  it("auto-enables Jamie for the Wiki when its API key is saved", async () => {
    vi.mocked(saveJamieWebhookApiKey).mockResolvedValueOnce({
      integrationId: "gint_jamie",
      webhookUrl: "https://example.test/webhooks/jamie",
      headerName: "x-jamie-api-key",
      apiKeyConfigured: true,
    });
    const db = fakeDb([[{ userWorkosId: "user_connector" }]]);
    const service = createIntegrationAccountService({ db });

    await expect(service.saveJamieWebhookApiKey(admin, "sk_x")).resolves.toMatchObject({
      integrationId: "gint_jamie",
      apiKeyConfigured: true,
    });
    expect(ensureWikiSourceEnabledOnConnect).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      provider: "jamie",
      integrationId: "gint_jamie",
      userWorkosId: "user_connector",
      createdByWorkosId: "user_1",
      db,
    });
  });
});
