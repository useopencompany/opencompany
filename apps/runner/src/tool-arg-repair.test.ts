import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareToolArgs } from "./tool-arg-repair";

// The repair layer calls a small model via the AI gateway. We mock the `ai` package's
// `generateObject` so these tests stay deterministic and never hit the network. Braintrust is
// mocked to the identity wrapper so `getBraintrustAISDK(ai)` returns the mocked module.

const aiMock = vi.hoisted(() => ({
  generateObject: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: aiMock.generateObject,
  createGateway: vi.fn(() => (model: string) => ({ model })),
  jsonSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock("@opencompany/observability/braintrust", () => ({
  getBraintrustAISDK: <T>(sdk: T) => sdk,
}));

vi.mock("@opencompany/observability", () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

const schema = {
  type: "object",
  properties: { query: { type: "string" }, count: { type: "number" } },
  required: ["query"],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareToolArgs", () => {
  it("returns valid args without invoking repair", async () => {
    const result = await prepareToolArgs({
      surface: "builtin",
      toolName: "search",
      schema,
      rawArgs: { query: "vercel" },
      repair: { apiKey: "key", enabled: true },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ query: "vercel" });
      expect(result.resolution.outcome).toBe("valid");
    }
    expect(aiMock.generateObject).not.toHaveBeenCalled();
  });

  it("coerces deterministically without invoking repair", async () => {
    const result = await prepareToolArgs({
      surface: "builtin",
      toolName: "search",
      schema,
      rawArgs: { query: "vercel", count: "3" },
      repair: { apiKey: "key", enabled: true },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ query: "vercel", count: 3 });
      expect(result.resolution.outcome).toBe("coerced");
      expect(result.resolution.coercions?.length).toBeGreaterThan(0);
    }
    expect(aiMock.generateObject).not.toHaveBeenCalled();
  });

  it("repairs via the model when coercion cannot fix it", async () => {
    // A misnamed field (`q` instead of `query`) — needs intent, so only the model can fix it.
    aiMock.generateObject.mockResolvedValueOnce({ object: { arguments: { query: "vercel" } } });

    const result = await prepareToolArgs({
      surface: "builtin",
      toolName: "search",
      schema,
      rawArgs: { q: "vercel" },
      repair: { apiKey: "key", enabled: true },
    });

    expect(aiMock.generateObject).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ query: "vercel" });
      expect(result.resolution.outcome).toBe("repaired");
      expect(result.resolution.repairModel).toBeTruthy();
      expect(result.resolution.failureClasses).toContain("missing_required");
    }
  });

  it("re-validates the repaired args and rejects an invalid repair", async () => {
    // The model returns args that still violate the schema (count is a string) — must not pass.
    aiMock.generateObject.mockResolvedValueOnce({
      object: { arguments: { query: "vercel", count: "still-bad" } },
    });

    const result = await prepareToolArgs({
      surface: "builtin",
      toolName: "search",
      schema,
      rawArgs: { q: "vercel" },
      repair: { apiKey: "key", enabled: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resolution.outcome).toBe("repair_failed");
    }
  });

  it("falls through when the model reports the call unrepairable", async () => {
    aiMock.generateObject.mockResolvedValueOnce({
      object: { unrepairable: true, reason: "no query value present" },
    });

    const result = await prepareToolArgs({
      surface: "mcp",
      toolName: "search",
      schema,
      rawArgs: {},
      repair: { apiKey: "key", enabled: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resolution.outcome).toBe("repair_failed");
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("falls through to a deterministic error when a model call throws", async () => {
    aiMock.generateObject.mockRejectedValueOnce(new Error("gateway exploded"));

    const result = await prepareToolArgs({
      surface: "builtin",
      toolName: "search",
      schema,
      rawArgs: { q: "vercel" },
      repair: { apiKey: "key", enabled: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resolution.outcome).toBe("repair_failed");
    }
  });

  it("skips repair entirely when disabled or no key is present", async () => {
    const disabled = await prepareToolArgs({
      surface: "builtin",
      toolName: "search",
      schema,
      rawArgs: { q: "vercel" },
      repair: { apiKey: "key", enabled: false },
    });
    const noKey = await prepareToolArgs({
      surface: "builtin",
      toolName: "search",
      schema,
      rawArgs: { q: "vercel" },
      repair: { enabled: true },
    });

    expect(aiMock.generateObject).not.toHaveBeenCalled();
    expect(disabled.ok).toBe(false);
    expect(noKey.ok).toBe(false);
    if (!disabled.ok) expect(disabled.resolution.outcome).toBe("errored");
    if (!noKey.ok) expect(noKey.resolution.outcome).toBe("errored");
  });
});
