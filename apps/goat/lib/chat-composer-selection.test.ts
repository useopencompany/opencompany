import { describe, expect, it } from "vitest";
import { normalizeStoredGoatChatSelection } from "@/lib/chat-composer-selection";
import { CODEX_PICKER_VALUE } from "@/lib/codex-chat-constants";
import { LOCAL_CODEX_PICKER_VALUE } from "@/lib/local-codex-constants";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";

describe("normalizeStoredGoatChatSelection", () => {
  it("restores supported Goat models", () => {
    expect(
      normalizeStoredGoatChatSelection("moonshotai/kimi-k3", {
        codexConnected: false,
        localCodexBetaEnabled: false,
      }),
    ).toBe("moonshotai/kimi-k3");
  });

  it("restores only engines that are currently available", () => {
    expect(
      normalizeStoredGoatChatSelection(CODEX_PICKER_VALUE, {
        codexConnected: true,
        localCodexBetaEnabled: false,
      }),
    ).toBe(CODEX_PICKER_VALUE);
    expect(
      normalizeStoredGoatChatSelection(LOCAL_CODEX_PICKER_VALUE, {
        codexConnected: false,
        localCodexBetaEnabled: true,
      }),
    ).toBe(LOCAL_CODEX_PICKER_VALUE);
    expect(
      normalizeStoredGoatChatSelection(CODEX_PICKER_VALUE, {
        codexConnected: false,
        localCodexBetaEnabled: false,
      }),
    ).toBe(DEFAULT_GOAT_MODEL);
  });

  it("falls back when a stale model id was stored", () => {
    expect(
      normalizeStoredGoatChatSelection("moonshotai/retired-model", {
        codexConnected: true,
        localCodexBetaEnabled: true,
      }),
    ).toBe(DEFAULT_GOAT_MODEL);
  });
});
