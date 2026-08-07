import { executeChatExaFetch, normalizePublicWebUrl } from "@opencompany/core/chat-web-fetch";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("executeChatExaFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches one known URL as bounded Exa page contents", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requestId: "exa_contents_123",
            costDollars: { total: 0.001 },
            results: [
              {
                title: "Example article",
                url: "https://example.com/article#section",
                author: "Ada Lovelace",
                publishedDate: "2026-07-20",
                text: "Readable page contents",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await executeChatExaFetch({
      toolInput: { url: "https://example.com/article#intro" },
      apiKey: "exa_test",
      signal: new AbortController().signal,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe("https://api.exa.ai/contents");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "exa_test",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      urls: ["https://example.com/article"],
      text: { maxCharacters: 20_000 },
      maxAgeHours: 24,
      livecrawlTimeout: 15_000,
    });
    expect(output).toEqual({
      ok: true,
      url: "https://example.com/article",
      title: "Example article",
      author: "Ada Lovelace",
      publishedDate: "2026-07-20",
      text: "Readable page contents",
      requestId: "exa_contents_123",
      costUsdMicros: 1000,
    });
  });

  it("reports provider extraction failures instead of returning empty content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [],
              statuses: [
                {
                  url: "https://example.com/private",
                  status: "error",
                  error: { tag: "CRAWL_NOT_ALLOWED", httpStatusCode: 403 },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(
      executeChatExaFetch({
        toolInput: { url: "https://example.com/private" },
        apiKey: "exa_test",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("HTTP 403 CRAWL_NOT_ALLOWED");
  });
});

describe("normalizePublicWebUrl", () => {
  it("accepts absolute HTTP URLs and strips fragments", () => {
    expect(normalizePublicWebUrl(" https://example.com/docs?q=goat#install ")).toBe(
      "https://example.com/docs?q=goat",
    );
  });

  it.each([
    "file:///etc/passwd",
    "https://user:secret@example.com",
    "not a URL",
  ])("rejects unsupported URL %s", (url) => {
    expect(() => normalizePublicWebUrl(url)).toThrow(/web_fetch/);
  });
});
