import { describe, expect, it } from "vitest";
import {
  GOAT_FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS,
  settledGoatCodingSandboxIdleTimeoutMs,
} from "./goat-coding-sandbox-lifecycle";

describe("settledGoatCodingSandboxIdleTimeoutMs", () => {
  it("keeps the configured timeout for interactive coding chats", () => {
    expect(
      settledGoatCodingSandboxIdleTimeoutMs({
        configuredIdleTimeoutMs: 30 * 60 * 1000,
        taskSession: false,
      }),
    ).toBe(30 * 60 * 1000);
  });

  it("caps finished task sandboxes at five minutes", () => {
    expect(
      settledGoatCodingSandboxIdleTimeoutMs({
        configuredIdleTimeoutMs: 30 * 60 * 1000,
        taskSession: true,
      }),
    ).toBe(GOAT_FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS);
  });

  it("does not extend a shorter configured task timeout", () => {
    expect(
      settledGoatCodingSandboxIdleTimeoutMs({
        configuredIdleTimeoutMs: 60_000,
        taskSession: true,
      }),
    ).toBe(60_000);
  });
});
