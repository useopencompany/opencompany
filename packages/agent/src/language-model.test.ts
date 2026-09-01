import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCodexSubscriptionEligibleModel, resolveLanguageModel } from "./language-model";

const dbMocks = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
}));

vi.mock("@opencompany/db/workspace-codex-engine", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadWorkspaceCodexEngineAccount: dbMocks.loadWorkspace,
}));

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.loadWorkspace.mockResolvedValue({
    enabled: true,
    providerUserWorkosId: "admin_1",
  });
});

describe("language model routing", () => {
  it("only considers the two exact GPT-5.6 subscription model ids eligible", () => {
    expect(isCodexSubscriptionEligibleModel("openai/gpt-5.6-sol")).toBe(true);
    expect(isCodexSubscriptionEligibleModel("openai/gpt-5.6-terra")).toBe(true);
    expect(isCodexSubscriptionEligibleModel("openai/gpt-5.6-sol-preview")).toBe(false);
    expect(isCodexSubscriptionEligibleModel("openai/gpt-5.5")).toBe(false);
  });

  it("routes an eligible workspace Chat to the designated subscription", async () => {
    const resolved = await resolveLanguageModel({
      modelId: "openai/gpt-5.6-sol",
      workspaceId: "workspace_1",
      feature: "chat",
      gatewayApiKey: "gateway-key",
      db: {},
    });

    expect(resolved.modelProvider).toBe("codex-subscription");
    expect(resolved.costSource).toBe("subscription_covered");
    expect(resolved.providerUserWorkosId).toBe("admin_1");
    expect((resolved.languageModel as { provider: string }).provider).toBe("codex-subscription");
  });

  it("keeps ineligible models on the metered gateway without reading a designation", async () => {
    const resolved = await resolveLanguageModel({
      modelId: "anthropic/claude-sonnet-5",
      workspaceId: "workspace_1",
      feature: "chat",
      gatewayApiKey: "gateway-key",
      db: {},
    });

    expect(resolved.modelProvider).toBe("vercel-ai-gateway");
    expect(resolved.costSource).toBe("metered_gateway");
    expect(dbMocks.loadWorkspace).not.toHaveBeenCalled();
  });
});
