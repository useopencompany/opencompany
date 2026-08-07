import { describe, expect, it } from "vitest";
import {
  FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS,
  settledCodingSandboxIdleTimeoutMs,
} from "./coding-sandbox-lifecycle";

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
