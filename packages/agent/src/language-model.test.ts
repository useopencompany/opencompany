import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGateway: vi.fn(() => (modelId: string) => ({ provider: "gateway", modelId })),
  loadWorkspaceCodexEngineAccount: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  createGateway: mocks.createGateway,
}));
vi.mock("@opencompany/db/codex-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/db/codex-auth")>()),
  loadWorkspaceCodexEngineAccount: mocks.loadWorkspaceCodexEngineAccount,
}));

import { isCodexSubscriptionModel, resolveProductLanguageModel } from "./language-model";

describe("resolveProductLanguageModel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recognizes only the subscription-eligible model IDs", () => {
    expect(isCodexSubscriptionModel("openai/gpt-6-astra")).toBe(false);
    expect(isCodexSubscriptionModel("openai/gpt-5.6-sol")).toBe(true);
    expect(isCodexSubscriptionModel("openai/gpt-5.6-terra")).toBe(true);
    expect(isCodexSubscriptionModel("openai/gpt-5.6-luna")).toBe(false);
    expect(isCodexSubscriptionModel("gpt-5.6-sol")).toBe(false);
  });

  it("selects Codex backend for an enabled designation even when reauth is needed", async () => {
    mocks.loadWorkspaceCodexEngineAccount.mockResolvedValue({
      enabled: true,
      providerUserWorkosId: "user_provider",
      credentialStatus: "needs_reauth",
    });

    const resolution = await resolveProductLanguageModel({
      workspaceId: "workspace_1",
      modelId: "openai/gpt-6-astra",
      feature: "chat",
      gatewayApiKey: "gateway-key",
      db: {},
    });

    expect(resolution.provider).toBe("codex-backend");
    expect(resolution.billing).toBe("subscription_covered");
    expect((resolution.model as { modelId: string }).modelId).toBe("gpt-5.6-sol");
    expect(mocks.createGateway).not.toHaveBeenCalled();
  });

  it("keeps non-eligible models on the metered gateway", async () => {
    const resolution = await resolveProductLanguageModel({
      workspaceId: "workspace_1",
      modelId: "openai/gpt-5.6-luna",
      feature: "task",
      gatewayApiKey: "gateway-key",
      db: {},
    });

    expect(resolution.provider).toBe("gateway");
    expect(resolution.billing).toBe("metered_gateway");
    expect(mocks.loadWorkspaceCodexEngineAccount).not.toHaveBeenCalled();
    expect(mocks.createGateway).toHaveBeenCalledWith({ apiKey: "gateway-key" });
  });
});
