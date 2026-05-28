import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAmpThreadCost } from "./amp-tool";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAmpThreadCost", () => {
  const threadId = "T-abc123";
  const apiKey = "sgamp_test_key";
  const baseUrl = "https://amp.test";

  it("returns cost in USD micros on successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            threadID: threadId,
            subThreadIDs: [],
            usage: 2.5,
            models: [
              {
                provider: "anthropic",
                model: "claude-sonnet-4-20250514",
                requests: 5,
                inputTokens: 10000,
                outputTokens: 2000,
                cacheReadInputTokens: 5000,
                cacheCreationInputTokens: 1000,
                usage: 2.5,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBe(2_500_000);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/v2/threads/${threadId}/usage`,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    );
  });

  it("returns null on 403 (non-Enterprise / forbidden)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Forbidden: missing client scope(s)" }), {
          status: 403,
        }),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null on 402 (payment required)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Payment required" }), { status: 402 }),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null on 401 (unauthorized)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network failure");
      }),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null when response body has no usage field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ threadID: threadId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null when usage is negative", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ threadID: threadId, subThreadIDs: [], usage: -1, models: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("rounds fractional micros correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ threadID: threadId, subThreadIDs: [], usage: 0.0035, models: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBe(3500);
  });
});
