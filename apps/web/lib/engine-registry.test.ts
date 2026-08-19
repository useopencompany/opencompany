import type { ConversationRuntimeView } from "@opencompany/agent/chat-ui";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_PICKER_VALUE,
  CODEX_PICKER_VALUE,
  ENGINE_REGISTRY,
  type EngineChatKind,
  engineLabel,
  statusPresenter,
} from "@/lib/engine-registry";

const ENGINES: readonly EngineChatKind[] = [CODEX_PICKER_VALUE, CLAUDE_PICKER_VALUE];

describe("statusPresenter", () => {
  // Regression guard for "Claude session shows Codex · Connecting": the pre-hydration
  // (null runtime) branch must present the session's own engine, never a default engine.
  it("labels the null-runtime (connecting) branch with the session engine, per engine", () => {
    for (const engine of ENGINES) {
      const meta = statusPresenter(engine, null);
      expect(meta.kind).toBe("connecting");
      expect(meta.label).toBe("Connecting");
      expect(meta.engineLabel).toBe(ENGINE_REGISTRY[engine].label);
    }
  });

  it("never labels a claude_code session with the Codex label in any runtime state", () => {
    const runtimes: (ConversationRuntimeView | null)[] = [
      null,
      { status: "queued", activeRunId: null, hasError: false, updatedAt: "" },
      { status: "starting", activeRunId: null, hasError: false, updatedAt: "" },
      { status: "running", activeRunId: "r1", hasError: false, updatedAt: "" },
      { status: "idle", activeRunId: null, hasError: false, updatedAt: "" },
      { status: "failed", activeRunId: null, hasError: true, updatedAt: "" },
      { status: "interrupted", activeRunId: null, hasError: false, updatedAt: "" },
    ];
    for (const runtime of runtimes) {
      expect(statusPresenter("claude_code", runtime).engineLabel).toBe("Claude Code");
      expect(statusPresenter("claude_code", runtime).engineLabel).not.toBe("Codex");
    }
  });

  it("maps runtime status to the shared status chip", () => {
    expect(statusPresenter("codex", null).kind).toBe("connecting");
    expect(
      statusPresenter("codex", {
        status: "running",
        activeRunId: "r",
        hasError: false,
        updatedAt: "",
      }).kind,
    ).toBe("working");
    expect(
      statusPresenter("codex", {
        status: "idle",
        activeRunId: null,
        hasError: false,
        updatedAt: "",
      }).kind,
    ).toBe("ready");
  });
});

describe("engineLabel", () => {
  it("returns each engine's own label", () => {
    expect(engineLabel("codex")).toBe("Codex");
    expect(engineLabel("claude_code")).toBe("Claude Code");
  });
});
