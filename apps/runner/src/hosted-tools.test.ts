import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { executeHostedTool, validateHostedToolEnvironment } from "./hosted-tools";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("executeHostedTool", () => {
  it("calls Exa search with defaults and normalizes compact output with cost usage", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            requestId: "exa_req_123",
            searchType: "auto",
            costDollars: { total: 0.007 },
            results: [
              {
                title: "Result",
                url: "https://example.com",
                publishedDate: "2026-05-22",
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

    const result = await executeHostedTool({
      name: "exa_search",
      args: { query: "latest Exa docs" },
      env: env(),
      enabledTools: ["tool_help", "exa_search"],
      signal: new AbortController().signal,
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
          query: "latest Exa docs",
          type: "auto",
          numResults: 5,
          contents: { highlights: true },
        }),
      }),
    );
    expect(result.output).toEqual({
      requestId: "exa_req_123",
      searchType: "auto",
      costDollars: 0.007,
      results: [
        {
          title: "Result",
          url: "https://example.com",
          publishedDate: "2026-05-22",
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

  it("passes optional Exa filters and fresh content settings", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ requestId: "req", searchType: "fast", results: [] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await executeHostedTool({
      name: "exa_search",
      args: {
        query: "official launch news",
        type: "fast",
        numResults: 20,
        category: "news",
        includeDomains: ["example.com"],
        excludeDomains: ["spam.test"],
        startPublishedDate: "2026-01-01",
        endPublishedDate: "2026-05-22",
        fresh: true,
      },
      env: env(),
      enabledTools: ["tool_help", "exa_search"],
      signal: new AbortController().signal,
    });

    const request = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(request).toMatchObject({
      query: "official launch news",
      type: "fast",
      numResults: 10,
      category: "news",
      includeDomains: ["example.com"],
      excludeDomains: ["spam.test"],
      startPublishedDate: "2026-01-01",
      endPublishedDate: "2026-05-22",
      contents: { highlights: true, maxAgeHours: 0 },
    });
  });

  it("surfaces Exa HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 })),
    );

    await expect(
      executeHostedTool({
        name: "exa_search",
        args: { query: "test" },
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Exa search failed (401): invalid key");
  });

  it("rejects malformed Exa responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ requestId: "req" }), { status: 200 })),
    );

    await expect(
      executeHostedTool({
        name: "exa_search",
        args: { query: "test" },
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("unexpected response shape");
  });

  it("fetches a web page and returns readable text with absolute links", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          `
            <!doctype html>
            <html>
              <head>
                <title>Example &amp; Docs</title>
                <meta name="description" content="A useful page">
                <style>.hidden { display: none; }</style>
              </head>
              <body>
                <nav><a href="/ignored">Navigation</a></nav>
                <main>
                  <h1>Example Docs</h1>
                  <p>This is the readable body.</p>
                  <script>window.nope = true;</script>
                  <a href="/next?x=1#section">Next page</a>
                  <a href="mailto:test@example.com">Email</a>
                </main>
              </body>
            </html>
          `,
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "web_fetch",
      args: { url: "https://example.com/docs/start", maxCharacters: 5000 },
      env: env(),
      enabledTools: ["tool_help", "web_fetch"],
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/docs/start",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: expect.stringContaining("text/html"),
        }),
        redirect: "follow",
      }),
    );
    expect(result.output).toMatchObject({
      url: "https://example.com/docs/start",
      status: 200,
      contentType: "text/html; charset=utf-8",
      title: "Example & Docs",
      description: "A useful page",
      text: expect.stringContaining("Example Docs\n\nThis is the readable body."),
      truncated: false,
      links: [
        { text: "Navigation", url: "https://example.com/ignored" },
        { text: "Next page", url: "https://example.com/next?x=1" },
      ],
    });
    expect(result.usage).toMatchObject({
      provider: "direct_http",
      operation: "fetch",
      costUsdMicros: 0,
    });
  });

  it("validates web_fetch URLs", async () => {
    await expect(
      executeHostedTool({
        name: "web_fetch",
        args: { url: "file:///etc/passwd" },
        env: env(),
        enabledTools: ["tool_help", "web_fetch"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("only supports http and https");
  });

  it("returns help only for enabled tools", async () => {
    await expect(
      executeHostedTool({
        name: "tool_help",
        args: { tool: "exa_search" },
        env: env(),
        enabledTools: ["tool_help"],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      output: {
        tool: "exa_search",
        error: "Tool is not enabled for this session or does not exist.",
      },
    });
  });
});

describe("validateHostedToolEnvironment", () => {
  it("requires EXA_API_KEY only when exa_search is enabled", () => {
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help"],
        env: env({ exaApiKey: undefined }),
      }),
    ).not.toThrow();
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "exa_search"],
        env: env({ exaApiKey: undefined }),
      }),
    ).toThrow("EXA_API_KEY");
  });
});

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "vag",
    exaApiKey: "exa_test",
    e2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner-test",
    ...overrides,
  };
}
