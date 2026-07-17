import { afterEach, describe, expect, it, vi } from "vitest";
import { goatFeatureFlagsFromUser } from "@/lib/feature-flags";

describe("goatFeatureFlagsFromUser", () => {
  it("defaults background task spawning to off", () => {
    expect(goatFeatureFlagsFromUser({}).taskSpawning).toBe(false);
    expect(goatFeatureFlagsFromUser({ taskSpawningEnabled: null }).taskSpawning).toBe(false);
  });

  it("enables background task spawning only for an explicit true value", () => {
    expect(goatFeatureFlagsFromUser({ taskSpawningEnabled: true }).taskSpawning).toBe(true);
    expect(goatFeatureFlagsFromUser({ taskSpawningEnabled: false }).taskSpawning).toBe(false);
  });

  it("defaults Local Codex bridge beta to off", () => {
    expect(goatFeatureFlagsFromUser({}).localCodexBridge).toBe(false);
    expect(goatFeatureFlagsFromUser({ localCodexBetaEnabled: null }).localCodexBridge).toBe(false);
  });

  it("enables Local Codex bridge beta only for an explicit true value", () => {
    expect(goatFeatureFlagsFromUser({ localCodexBetaEnabled: true }).localCodexBridge).toBe(true);
    expect(goatFeatureFlagsFromUser({ localCodexBetaEnabled: false }).localCodexBridge).toBe(false);
  });

  describe("main-chat integration tools beta", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("defaults to off", () => {
      expect(goatFeatureFlagsFromUser({}).mainChatIntegrationTools).toBe(false);
      expect(
        goatFeatureFlagsFromUser({ mainChatIntegrationToolsBetaEnabled: null })
          .mainChatIntegrationTools,
      ).toBe(false);
    });

    it("enables only for an explicit true value", () => {
      expect(
        goatFeatureFlagsFromUser({ mainChatIntegrationToolsBetaEnabled: true })
          .mainChatIntegrationTools,
      ).toBe(true);
      expect(
        goatFeatureFlagsFromUser({ mainChatIntegrationToolsBetaEnabled: false })
          .mainChatIntegrationTools,
      ).toBe(false);
    });

    it("is forced off by the global kill switch", () => {
      vi.stubEnv("GOAT_MAIN_CHAT_INTEGRATION_TOOLS_DISABLED", "true");
      expect(
        goatFeatureFlagsFromUser({ mainChatIntegrationToolsBetaEnabled: true })
          .mainChatIntegrationTools,
      ).toBe(false);
    });
  });
});
