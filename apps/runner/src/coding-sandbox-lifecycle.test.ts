import { describe, expect, it } from "vitest";
import {
  ACTIVE_CODING_SANDBOX_TIMEOUT_MS,
  CODING_SANDBOX_TURN_GRACE_MS,
  DEFAULT_CODING_AGENT_TURN_TIMEOUT_MS,
  FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS,
  settledCodingSandboxIdleTimeoutMs,
} from "./coding-sandbox-lifecycle";

describe("coding sandbox active timeout", () => {
  it("allows Codex and Claude Code turns to run for three hours", () => {
    expect(DEFAULT_CODING_AGENT_TURN_TIMEOUT_MS).toBe(3 * 60 * 60 * 1000);
    expect(ACTIVE_CODING_SANDBOX_TIMEOUT_MS).toBe(
      DEFAULT_CODING_AGENT_TURN_TIMEOUT_MS + CODING_SANDBOX_TURN_GRACE_MS,
    );
  });
});

describe("settledCodingSandboxIdleTimeoutMs", () => {
  it("keeps the configured timeout for interactive coding chats", () => {
    expect(
      settledCodingSandboxIdleTimeoutMs({
        configuredIdleTimeoutMs: 30 * 60 * 1000,
        taskSession: false,
      }),
    ).toBe(30 * 60 * 1000);
  });

  it("caps finished task sandboxes at five minutes", () => {
    expect(
      settledCodingSandboxIdleTimeoutMs({
        configuredIdleTimeoutMs: 30 * 60 * 1000,
        taskSession: true,
      }),
    ).toBe(FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS);
  });

  it("does not extend a shorter configured task timeout", () => {
    expect(
      settledCodingSandboxIdleTimeoutMs({
        configuredIdleTimeoutMs: 60_000,
        taskSession: true,
      }),
    ).toBe(60_000);
  });
});
