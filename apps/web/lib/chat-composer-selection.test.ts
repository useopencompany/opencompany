import { describe, expect, it } from "vitest";
import { AUTO_MODEL_SELECTION } from "@/lib/chat-auto-model";
import { normalizeStoredChatSelection } from "@/lib/chat-composer-selection";
import { CODEX_PICKER_VALUE } from "@/lib/engine-registry";
import { DEFAULT_MODEL } from "@/lib/model-options";

describe("normalizeStoredChatSelection", () => {
  it("restores supported opencompany models", () => {
    expect(
      normalizeStoredChatSelection("moonshotai/kimi-k3", {
        codexConnected: false,
      }),
    ).toBe("moonshotai/kimi-k3");
  });

  it("restores only engines that are currently available", () => {
    expect(
      normalizeStoredChatSelection(CODEX_PICKER_VALUE, {
        codexConnected: true,
      }),
    ).toBe(CODEX_PICKER_VALUE);
    expect(
      normalizeStoredChatSelection(CODEX_PICKER_VALUE, {
        codexConnected: false,
      }),
    ).toBe(DEFAULT_MODEL);
  });

  it("falls back when a stale model id was stored", () => {
    expect(
      normalizeStoredChatSelection("moonshotai/retired-model", {
        codexConnected: true,
      }),
    ).toBe(DEFAULT_MODEL);
  });

  it("restores Auto only while the feature flag is enabled", () => {
    expect(
      normalizeStoredChatSelection(AUTO_MODEL_SELECTION, {
        codexConnected: false,
        autoModelRoutingEnabled: true,
      }),
    ).toBe(AUTO_MODEL_SELECTION);
    expect(
      normalizeStoredChatSelection(AUTO_MODEL_SELECTION, {
        codexConnected: false,
        autoModelRoutingEnabled: false,
      }),
    ).toBe(DEFAULT_MODEL);
  });
});
