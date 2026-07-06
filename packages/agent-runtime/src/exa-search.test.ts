import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExaSearchRequest, executeExaSearchRequest } from "./exa-search";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Exa search helper", () => {
  it("builds a cheap chat search request with fast highlights", () => {
    expect(
      buildExaSearchRequest({ query: "latest Google updates" }, { type: "fast", numResults: 5 }),
    ).toEqual({
      query: "latest Google updates",
      type: "fast",
      numResults: 5,
      contents: { highlights: true },
    });
  });

  it("passes recency filters through as published date filters", () => {
    expect(
      buildExaSearchRequest(
        {
          query: "Google updates",
          startPublishedDate: "2026-06-27T00:00:00.000Z",
        },
        { type: "fast", numResults: 5 },
      ),
    ).toMatchObject({
      query: "Google updates",
      type: "fast",
      numResults: 5,
      startPublishedDate: "2026-06-27T00:00:00.000Z",
      contents: { highlights: true },
    });
  });

  it("normalizes search output and provider cost", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            requestId: "exa_req_123",
            searchType: "fast",
            costDollars: { total: 0.007 },
            results: [
              {
                title: "Result",
                url: "https://example.com",
                publishedDate: "2026-07-04",
                author: "Example Author",
                highlights: ["Relevant excerpt"],
                summary: "Short summary",
                text: "Full text should not be forwarded",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeExaSearchRequest({
      apiKey: "exa_test",
      args: { query: "latest Google updates" },
      signal: new AbortController().signal,
      defaults: { type: "fast", numResults: 5 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.exa.ai/search",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "exa_test",
        },
        body: JSON.stringify({
          query: "latest Google updates",
          type: "fast",
          numResults: 5,
          contents: { highlights: true },
        }),
      }),
    );
    expect(result.output).toEqual({
      requestId: "exa_req_123",
      searchType: "fast",
      costDollars: 0.007,
      results: [
        {
          title: "Result",
          url: "https://example.com",
          publishedDate: "2026-07-04",
          author: "Example Author",
          highlights: ["Relevant excerpt"],
          summary: "Short summary",
        },
      ],
    });
    expect(result.usage).toMatchObject({
      provider: "exa",
      operation: "search",
      providerRequestId: "exa_req_123",
      costUsdMicros: 7000,
    });
  });

  it("surfaces Exa HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 })),
    );

    await expect(
      executeExaSearchRequest({
        apiKey: "exa_test",
        args: { query: "latest Google updates" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Exa search failed (401): invalid key");
  });

  it("rejects malformed Exa responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ results: null }), { status: 200 })),
    );

    await expect(
      executeExaSearchRequest({
        apiKey: "exa_test",
        args: { query: "latest Google updates" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Exa search returned an unexpected response shape.");
  });
});
