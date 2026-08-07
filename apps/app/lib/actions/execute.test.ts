import { ACTION_EFFECTS_READ } from "@opencompany/core/actions/types";
import { describe, expect, it, vi } from "vitest";
import {
  clampActionResult,
  executeAction,
  MAX_ACTION_RESULT_CHARS,
  MAX_EXPANDED_ACTION_RESULT_CHARS,
} from "@/lib/actions/execute";
import {
  ActionAuthError,
  ActionInvalidParamsError,
  type ResolvedAction,
  type ResolvedActionCatalog,
} from "@/lib/actions/types";

function catalogWith(
  execute: ResolvedAction["execute"],
  options: Pick<ResolvedAction, "maxResultChars"> = {},
): ResolvedActionCatalog {
  return {
    providers: [{ id: "slack", label: "Slack", description: "Read Slack messages." }],
    actions: [
      {
        id: "slack.fetch_history",
        provider: "slack",
        capability: "read",
        effects: ACTION_EFFECTS_READ,
        permissionMode: "on",
        description: "fetch",
        params: { type: "object" },
        ...options,
        execute,
      },
    ],
  };
}

function baseInput(catalog: ResolvedActionCatalog) {
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

describe("executeAction", () => {
  it("returns invalid_params for unknown action ids without executing", async () => {
    const execute = vi.fn();
    const result = await executeAction({
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
    const result = await executeAction(baseInput(catalogWith(execute)));
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

  it("honors an action-specific expanded result allowance", async () => {
    const expanded = { transcript: "x".repeat(MAX_ACTION_RESULT_CHARS + 100) };
    const result = await executeAction(
      baseInput(
        catalogWith(async () => expanded, {
          maxResultChars: MAX_EXPANDED_ACTION_RESULT_CHARS,
        }),
      ),
    );

    expect(result).toEqual({
      ok: true,
      action: "slack.fetch_history",
      result: expanded,
    });
  });

  it("maps auth errors to structured results with the reconnect hint", async () => {
    const result = await executeAction(
      baseInput(
        catalogWith(async () => {
          throw new ActionAuthError("auth_expired", "slack", "Reconnect Slack in Settings.");
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
    const invalid = await executeAction(
      baseInput(
        catalogWith(async () => {
          throw new ActionInvalidParamsError('"channel" is required.');
        }),
      ),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid_params");
      expect(invalid.error.message).toContain('"channel" is required.');
    }

    const provider = await executeAction(
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
    await expect(executeAction(input)).rejects.toBeDefined();
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

  it("allows a deliberately expanded result without exceeding the hard cap", () => {
    const expanded = { transcript: "x".repeat(MAX_ACTION_RESULT_CHARS + 100) };
    expect(clampActionResult(expanded, MAX_EXPANDED_ACTION_RESULT_CHARS)).toBe(expanded);

    const oversized = {
      transcript: "x".repeat(MAX_EXPANDED_ACTION_RESULT_CHARS + 100),
    };
    expect(
      JSON.stringify(clampActionResult(oversized, Number.MAX_SAFE_INTEGER)).length,
    ).toBeLessThanOrEqual(MAX_EXPANDED_ACTION_RESULT_CHARS);
  });
});
