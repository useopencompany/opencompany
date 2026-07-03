import { afterEach, describe, expect, it, vi } from "vitest";
import {
  categorizeGoatFailure,
  hashGoatUserId,
  isGoatObservabilityEnabled,
  recordGoatCounter,
  sanitizeGoatAttributes,
  startGoatSpan,
} from ".";

describe("@opencompany/goat-observability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sanitizes attributes and drops text-like fields", () => {
    expect(
      sanitizeGoatAttributes({
        "goat.task_id": "goat_task_1",
        "goat.prompt": "secret prompt",
        "goat.tool_input": "secret args",
        "goat.tool_name": "exa_search",
        "goat.token_direction": "input",
        "other.value": "ignored",
        "goat.count": 2,
        "goat.empty": null,
      }),
    ).toEqual({
      "goat.task_id": "goat_task_1",
      "goat.tool_name": "exa_search",
      "goat.token_direction": "input",
      "goat.count": 2,
    });
  });

  it("hashes user ids without exposing the source value", () => {
    const first = hashGoatUserId("user_123");
    const second = hashGoatUserId("user_123");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toContain("user_123");
  });

  it("categorizes common failures", () => {
    expect(categorizeGoatFailure(new Error("Goat task lease lost while trying to complete."))).toBe(
      "lease_lost",
    );
    expect(categorizeGoatFailure(new Error("VERCEL_AI_GATEWAY_API_KEY is required."))).toBe("auth");
    expect(categorizeGoatFailure(new Error("Gmail integration needs reauth."))).toBe("integration");
    expect(categorizeGoatFailure(new TypeError("Cannot read properties of undefined"))).toBe("bug");
  });

  it("no-ops safely when disabled", () => {
    vi.stubEnv("GOAT_OBSERVABILITY_ENABLED", "false");
    expect(isGoatObservabilityEnabled()).toBe(false);
    expect(() => recordGoatCounter("goat.test", 1, { "goat.task_id": "task" })).not.toThrow();
    const span = startGoatSpan("goat.test", { "goat.task_id": "task" });
    expect(() => {
      span.setAttributes({ "goat.status": "running" });
      span.fail(new Error("boom"));
      span.end();
    }).not.toThrow();
  });
});
