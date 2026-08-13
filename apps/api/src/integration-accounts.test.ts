import type { Actor } from "@opencompany/core";
import {
  consumeGoatImessageChallenge,
  getGoatImessagePairingChallenge,
  incrementGoatImessageChallengeAttempts,
  upsertGoatImessagePairingChallenge,
} from "@opencompany/db/goat-imessage";
import {
  applyGoatIntegrationCapabilityMode,
  disconnectGoatPersonalIntegration,
} from "@opencompany/db/goat-integrations";
import {
  connectGoatImessageIntegration,
  getGoatImessageIntegrationState,
  hashGoatImessagePairingCode,
} from "@opencompany/goat-agent/imessage/connect";
import {
  connectGoatGranolaIntegration,
  getGoatGranolaIntegrationState,
  validateGoatGranolaApiKey,
} from "@opencompany/goat-agent/integrations/granola";
import { saveGoatJamieWebhookApiKey } from "@opencompany/goat-agent/integrations/jamie";
import { disconnectGoatStripeIntegration } from "@opencompany/goat-agent/integrations/stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationAccountService } from "./integration-accounts";

vi.mock("@opencompany/db/goat-integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyGoatIntegrationCapabilityMode: vi.fn(async () => undefined),
  disconnectGoatPersonalIntegration: vi.fn(async () => true),
  loadGoatIntegrationCredential: vi.fn(async () => null),
}));

vi.mock("@opencompany/db/goat-imessage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGoatImessagePairingChallenge: vi.fn(async () => null),
  upsertGoatImessagePairingChallenge: vi.fn(async () => undefined),
  incrementGoatImessageChallengeAttempts: vi.fn(async () => undefined),
  consumeGoatImessageChallenge: vi.fn(async () => undefined),
  recordGoatImessageSend: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/goat-agent/imessage/connect", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectGoatImessageIntegration: vi.fn(async () => ({ integrationId: "gint_imsg" })),
  getGoatImessageIntegrationState: vi.fn(async () => ({
    provider: "imessage" as const,
    connected: true,
    status: "connected" as const,
    integrationId: "gint_imsg",
    phoneE164: "+14155551234",
    statusReason: null,
  })),
}));

vi.mock("@opencompany/goat-agent/integrations/granola", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateGoatGranolaApiKey: vi.fn(),
  connectGoatGranolaIntegration: vi.fn(async () => ({ integrationId: "gint_granola" })),
  getGoatGranolaIntegrationState: vi.fn(async () => ({
    provider: "granola" as const,
    connected: true,
    status: "connected" as const,
    integrationId: "gint_granola",
    accountEmail: "sam@example.com",
    accountName: "Sam",
    statusReason: null,
  })),
}));

vi.mock("@opencompany/goat-agent/integrations/jamie", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createOrResetGoatJamieWebhookEndpoint: vi.fn(),
  saveGoatJamieWebhookApiKey: vi.fn(),
}));

vi.mock("@opencompany/goat-agent/integrations/stripe", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateGoatStripeRestrictedApiKey: vi.fn(),
  connectGoatStripeIntegration: vi.fn(),
  getGoatStripeIntegrationState: vi.fn(),
  disconnectGoatStripeIntegration: vi.fn(async () => false),
}));

vi.mock("@opencompany/goat-agent/integrations/analytics", () => ({
  captureGoatIntegrationAddedAnalytics: vi.fn(async () => undefined),
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
    vi.mocked(disconnectGoatPersonalIntegration).mockResolvedValueOnce(false);
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.disconnect(member, "gint_x")).rejects.toMatchObject({
      status: 404,
      message: "Only the connection owner can manage this account.",
    });
  });

  it("runs the shared disconnect for the owner", async () => {
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.disconnect(member, "gint_x")).resolves.toBeUndefined();
    expect(disconnectGoatPersonalIntegration).toHaveBeenCalledWith(
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
    expect(applyGoatIntegrationCapabilityMode).not.toHaveBeenCalled();
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
    expect(applyGoatIntegrationCapabilityMode).toHaveBeenCalledWith(
      expect.objectContaining({ integrationIds: ["gint_x"], capabilityId: "write", mode: "ask" }),
    );
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
    vi.mocked(validateGoatGranolaApiKey).mockResolvedValueOnce({
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
    expect(connectGoatGranolaIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", apiKey: "grn_valid_key_12345" }),
    );
    expect(getGoatGranolaIntegrationState).toHaveBeenCalled();
  });

  it("surfaces provider-rejected keys with the validator's message", async () => {
    vi.mocked(validateGoatGranolaApiKey).mockResolvedValueOnce({
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
      text: "Your OpenCompany verification code is 123456. It expires in 10 minutes.",
    });
    expect(upsertGoatImessagePairingChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", phoneE164: "+14155551234" }),
      expect.anything(),
    );
  });

  it("throttles pairing resends inside the cooldown window", async () => {
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.mocked(getGoatImessagePairingChallenge).mockResolvedValueOnce({
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
    const codeHash = hashGoatImessagePairingCode({
      code: "654321",
      userWorkosId: "user_1",
      phoneE164: "+14155551234",
    });
    vi.mocked(getGoatImessagePairingChallenge).mockResolvedValueOnce({
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
    expect(consumeGoatImessageChallenge).toHaveBeenCalledWith("chal_1", expect.anything());
    expect(connectGoatImessageIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1", phoneE164: "+14155551234" }),
    );
  });

  it("counts down remaining attempts on a mismatched code", async () => {
    const now = new Date("2026-08-13T08:00:00.000Z");
    vi.mocked(getGoatImessagePairingChallenge).mockResolvedValueOnce({
      id: "chal_1",
      phoneE164: "+14155551234",
      codeHash: hashGoatImessagePairingCode({
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
    expect(incrementGoatImessageChallengeAttempts).toHaveBeenCalledWith(
      "chal_1",
      expect.anything(),
    );
    expect(getGoatImessageIntegrationState).not.toHaveBeenCalled();
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
    vi.mocked(disconnectGoatStripeIntegration).mockResolvedValueOnce(false);
    await expect(service.disconnectStripe(admin)).rejects.toMatchObject({
      status: 404,
      message: "Stripe is not connected.",
    });
  });

  it("surfaces Jamie lib validation errors verbatim like the retired action", async () => {
    vi.mocked(saveGoatJamieWebhookApiKey).mockRejectedValueOnce(
      new Error("Create a Jamie webhook endpoint before saving the API key."),
    );
    const service = createIntegrationAccountService({ db: fakeDb() });
    await expect(service.saveJamieWebhookApiKey(admin, "sk_x")).rejects.toMatchObject({
      status: 400,
      message: "Create a Jamie webhook endpoint before saving the API key.",
    });
  });
});
