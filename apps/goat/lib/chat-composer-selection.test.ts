import { describe, expect, it } from "vitest";
import { AUTO_GOAT_MODEL_SELECTION } from "@/lib/chat-auto-model";
import { normalizeStoredGoatChatSelection } from "@/lib/chat-composer-selection";
import { CODEX_PICKER_VALUE } from "@/lib/codex-chat-constants";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";

describe("normalizeStoredGoatChatSelection", () => {
  it("restores supported Goat models", () => {
    expect(
      normalizeStoredGoatChatSelection("moonshotai/kimi-k3", {
        codexConnected: false,
      }),
    ).toBe("moonshotai/kimi-k3");
  });

  it("restores only engines that are currently available", () => {
    expect(
      normalizeStoredGoatChatSelection(CODEX_PICKER_VALUE, {
        codexConnected: true,
      }),
    ).toBe(CODEX_PICKER_VALUE);
    expect(
      normalizeStoredGoatChatSelection(CODEX_PICKER_VALUE, {
        codexConnected: false,
      }),
    ).toBe(DEFAULT_GOAT_MODEL);
  });

  it("falls back when a stale model id was stored", () => {
    expect(
      normalizeStoredGoatChatSelection("moonshotai/retired-model", {
        codexConnected: true,
      }),
    ).toBe(DEFAULT_GOAT_MODEL);
  });

  it("restores Auto only while the feature flag is enabled", () => {
    expect(
      normalizeStoredGoatChatSelection(AUTO_GOAT_MODEL_SELECTION, {
        codexConnected: false,
        autoModelRoutingEnabled: true,
      }),
    ).toBe(AUTO_GOAT_MODEL_SELECTION);
    expect(
      normalizeStoredGoatChatSelection(AUTO_GOAT_MODEL_SELECTION, {
        codexConnected: false,
        autoModelRoutingEnabled: false,
      }),
    ).toBe(DEFAULT_GOAT_MODEL);
  });
});
