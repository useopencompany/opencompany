import { describe, expect, it } from "vitest";
import { goatFeatureFlagsFromUser } from "@/lib/feature-flags";

describe("goatFeatureFlagsFromUser", () => {
  it("defaults Local Codex bridge beta to off", () => {
    expect(goatFeatureFlagsFromUser({}).localCodexBridge).toBe(false);
    expect(goatFeatureFlagsFromUser({ localCodexBetaEnabled: null }).localCodexBridge).toBe(false);
  });

  it("enables Local Codex bridge beta only for an explicit true value", () => {
    expect(goatFeatureFlagsFromUser({ localCodexBetaEnabled: true }).localCodexBridge).toBe(true);
    expect(goatFeatureFlagsFromUser({ localCodexBetaEnabled: false }).localCodexBridge).toBe(false);
  });
});
