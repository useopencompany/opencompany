import { describe, expect, it, vi } from "vitest";
import {
  clampActionResult,
  executeGoatAction,
  MAX_ACTION_RESULT_CHARS,
} from "@/lib/actions/execute";
import {
  GoatActionAuthError,
  GoatActionInvalidParamsError,
  type GoatResolvedActionCatalog,
  type ResolvedGoatAction,
} from "@/lib/actions/types";

function catalogWith(execute: ResolvedGoatAction["execute"]): GoatResolvedActionCatalog {
  return {
    providers: [{ id: "slack", label: "Slack", description: "Read Slack messages." }],
    actions: [
      {
        id: "slack.fetch_history",
        provider: "slack",
        description: "fetch",
        params: { type: "object" },
        execute,
      },
    ],
  };
}

function baseInput(catalog: GoatResolvedActionCatalog) {
  return {
    catalog,
    actionId: "slack.fetch_history",
    params: { channel: "C1" },
    userWorkosId: "user_1",
    signal: new AbortController().signal,
    currentDate: new Date("2026-07-18T00:00:00.000Z"),
    userTimezone: "UTC",
  };
}

describe("executeGoatAction", () => {
  it("returns invalid_params for unknown action ids without executing", async () => {
    const execute = vi.fn();
    const result = await executeGoatAction({
      ...baseInput(catalogWith(execute)),
      actionId: "gmail.get_message",
    });
    expect(result).toEqual({
      ok: false,
      action: "gmail.get_message",
      error: expect.objectContaining({ code: "invalid_params" }),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the clamped result on success", async () => {
    const execute = vi.fn(async () => ({ messages: ["hi"] }));
    const result = await executeGoatAction(baseInput(catalogWith(execute)));
    expect(result).toEqual({
      ok: true,
      action: "slack.fetch_history",
      result: { messages: ["hi"] },
    });
    expect(execute).toHaveBeenCalledWith(
      { channel: "C1" },
      expect.objectContaining({ userTimezone: "UTC" }),
    );
  });

  it("maps auth errors to structured results with the reconnect hint", async () => {
    const result = await executeGoatAction(
      baseInput(
        catalogWith(async () => {
          throw new GoatActionAuthError("auth_expired", "slack", "Reconnect Slack in Settings.");
        }),
      ),
    );
    expect(result).toEqual({
      ok: false,
      action: "slack.fetch_history",
      error: {
        code: "auth_expired",
        source: "slack",
        message: "Reconnect Slack in Settings.",
      },
    });
  });

  it("maps validation errors to invalid_params and other errors to provider_error", async () => {
    const invalid = await executeGoatAction(
      baseInput(
        catalogWith(async () => {
          throw new GoatActionInvalidParamsError('"channel" is required.');
        }),
      ),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid_params");
      expect(invalid.error.message).toContain('"channel" is required.');
    }

    const provider = await executeGoatAction(
      baseInput(
        catalogWith(async () => {
          throw new Error("Slack API request failed with 500.");
        }),
      ),
    );
    expect(provider.ok).toBe(false);
    if (!provider.ok) expect(provider.error.code).toBe("provider_error");
  });

  it("rethrows when the parent chat signal aborted", async () => {
    const controller = new AbortController();
    const input = {
      ...baseInput(
        catalogWith(async (_params, context) => {
          controller.abort();
          throw context.signal.reason ?? new Error("aborted");
        }),
      ),
      signal: controller.signal,
    };
    await expect(executeGoatAction(input)).rejects.toBeDefined();
  });
});

describe("clampActionResult", () => {
  it("passes small values through untouched", () => {
    const value = { a: 1, b: "two" };
    expect(clampActionResult(value)).toBe(value);
  });

  it("truncates oversized payloads with a steering note", () => {
    const value = { blob: "x".repeat(MAX_ACTION_RESULT_CHARS + 100) };
    const clamped = clampActionResult(value) as {
      truncated: boolean;
      note: string;
      resultPreview: string;
    };
    expect(clamped.truncated).toBe(true);
    expect(clamped.note).toContain("narrow the request");
    expect(clamped.resultPreview.length).toBeGreaterThan(0);
    expect(JSON.stringify(clamped).length).toBeLessThanOrEqual(MAX_ACTION_RESULT_CHARS);
  });

  it("preserves managed capability activity metadata when truncating its payload", () => {
    const clamped = clampActionResult({
      untrustedProviderData: true,
      securityNotice: "External data",
      source: "x",
      action: "x.search_posts",
      resultCount: 20,
      canonicalLinks: ["https://x.com/openai/status/123456789"],
      cost: { state: "settled", totalUsdMicros: 1_800 },
      payload: { items: [{ text: "x".repeat(MAX_ACTION_RESULT_CHARS + 100) }] },
    }) as Record<string, unknown>;
    expect(clamped).toMatchObject({
      untrustedProviderData: true,
      source: "x",
      action: "x.search_posts",
      resultCount: 20,
      cost: { state: "settled", totalUsdMicros: 1_800 },
      payload: { truncated: true },
    });
    expect(JSON.stringify(clamped).length).toBeLessThanOrEqual(MAX_ACTION_RESULT_CHARS);
  });
});
