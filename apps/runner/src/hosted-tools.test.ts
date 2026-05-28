import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import {
  executeHostedTool,
  getHostedToolFailureContext,
  MissingEnvError,
  validateHostedToolEnvironment,
} from "./hosted-tools";

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

  it("rejects Exa company and people searches with unsupported filters before calling Exa", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeHostedTool({
        name: "exa_search",
        args: {
          query: "OpenAI leadership",
          category: "people",
          excludeDomains: ["example.com"],
          startPublishedDate: "2026-01-01",
        },
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Exa company and people category searches do not support excludeDomains or published date filters.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Exa people searches with non-LinkedIn includeDomains before calling Exa", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeHostedTool({
        name: "exa_search",
        args: {
          query: "OpenAI leadership",
          category: "people",
          includeDomains: ["example.com"],
        },
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Exa people category searches only support LinkedIn includeDomains.");
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("calls Exa contents for focused highlights and normalizes statuses", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            requestId: "contents_req_123",
            costDollars: { total: 0.004 },
            results: [
              {
                title: "Example Docs",
                url: "https://example.com/docs",
                highlights: ["Relevant docs excerpt"],
                extras: { links: ["https://example.com/docs/api"] },
                subpages: [
                  {
                    title: "API",
                    url: "https://example.com/docs/api",
                    highlights: ["API excerpt"],
                  },
                ],
              },
            ],
            statuses: [
              { id: "https://example.com/docs", status: "success" },
              {
                id: "https://example.com/missing",
                status: "error",
                error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "exa_contents",
      args: {
        urls: ["https://example.com/docs"],
        query: "API reference",
        maxCharacters: 2000,
        maxAgeHours: 0,
        subpages: 3,
        subpageTarget: ["api"],
        includeLinks: true,
      },
      env: env(),
      enabledTools: ["tool_help", "exa_contents"],
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.exa.ai/contents",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "exa_test",
        },
        body: JSON.stringify({
          urls: ["https://example.com/docs"],
          maxAgeHours: 0,
          livecrawlTimeout: 15000,
          subpages: 3,
          subpageTarget: ["api"],
          extras: { links: 20 },
          highlights: { query: "API reference", maxCharacters: 2000 },
        }),
      }),
    );
    expect(result.output).toEqual({
      requestId: "contents_req_123",
      costDollars: 0.004,
      results: [
        {
          title: "Example Docs",
          url: "https://example.com/docs",
          highlights: ["Relevant docs excerpt"],
          extras: { links: ["https://example.com/docs/api"] },
          subpages: [
            {
              title: "API",
              url: "https://example.com/docs/api",
              highlights: ["API excerpt"],
            },
          ],
        },
      ],
      statuses: [
        { id: "https://example.com/docs", status: "success" },
        {
          id: "https://example.com/missing",
          status: "error",
          error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
        },
      ],
    });
    expect(result.usage).toMatchObject({
      provider: "exa",
      operation: "contents",
      providerRequestId: "contents_req_123",
      costUsdMicros: 4000,
    });
  });

  it("calls Exa contents with text mode and truncates returned text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  title: "Long Page",
                  url: "https://example.com/long",
                  text: "x".repeat(2000),
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await executeHostedTool({
      name: "exa_contents",
      args: {
        urls: ["https://example.com/long"],
        mode: "text",
        maxCharacters: 1000,
      },
      env: env(),
      enabledTools: ["tool_help", "exa_contents"],
      signal: new AbortController().signal,
    });

    expect((result.output as { results: Array<{ text: string }> }).results[0]?.text).toHaveLength(
      1000,
    );
  });

  it("calls Exa answer with compact citations", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            requestId: "answer_req_123",
            answer: "Paris.",
            citations: [
              {
                title: "Paris",
                url: "https://example.com/paris",
                text: "Full source text should not be forwarded by default",
              },
            ],
            costDollars: { total: 0.006 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "exa_answer",
      args: {
        query: "What is the capital of France?",
        outputSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
      env: env(),
      enabledTools: ["tool_help", "exa_answer"],
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.exa.ai/answer",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "exa_test",
        },
        body: JSON.stringify({
          query: "What is the capital of France?",
          outputSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        }),
      }),
    );
    expect(result.output).toEqual({
      requestId: "answer_req_123",
      answer: "Paris.",
      costDollars: 0.006,
      citations: [
        {
          title: "Paris",
          url: "https://example.com/paris",
        },
      ],
    });
    expect(result.usage).toMatchObject({
      provider: "exa",
      operation: "answer",
      providerRequestId: "answer_req_123",
      costUsdMicros: 6000,
    });
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

describe("getHostedToolFailureContext", () => {
  it("classifies unsupported Exa category/filter combinations for monitoring", () => {
    expect(
      getHostedToolFailureContext({
        name: "exa_search",
        args: {
          query: "OpenAI leadership",
          category: "people",
          excludeDomains: ["example.com"],
          startPublishedDate: "2026-01-01",
        },
        error: new Error(
          "Exa company and people category searches do not support excludeDomains or published date filters.",
        ),
      }),
    ).toMatchObject({
      hosted_provider: "exa",
      hosted_operation: "search",
      tool_error_stage: "request_validation",
      tool_error_code: "exa_unsupported_category_filter_combination",
      exa_category: "people",
      exa_has_exclude_domains: true,
      exa_has_published_date_filter: true,
    });
  });

  it("classifies unsupported Exa people includeDomains for monitoring", () => {
    expect(
      getHostedToolFailureContext({
        name: "exa_search",
        args: {
          query: "OpenAI leadership",
          category: "people",
          includeDomains: ["example.com"],
        },
        error: new Error("Exa people category searches only support LinkedIn includeDomains."),
      }),
    ).toMatchObject({
      hosted_provider: "exa",
      hosted_operation: "search",
      tool_error_stage: "request_validation",
      tool_error_code: "exa_unsupported_people_domain_filter",
      exa_category: "people",
    });
  });

  it("classifies Exa provider HTTP failures with status", () => {
    expect(
      getHostedToolFailureContext({
        name: "exa_search",
        args: { query: "test" },
        error: new Error("Exa search failed (401): invalid key"),
      }),
    ).toMatchObject({
      hosted_provider: "exa",
      hosted_operation: "search",
      tool_error_stage: "provider_response",
      tool_error_code: "exa_http_error",
      provider_status: 401,
    });
  });

  it("classifies Exa contents validation failures", () => {
    expect(
      getHostedToolFailureContext({
        name: "exa_contents",
        args: { urls: [] },
        error: new Error("exa_contents urls must include at least one URL."),
      }),
    ).toMatchObject({
      hosted_provider: "exa",
      hosted_operation: "contents",
      tool_error_stage: "request_validation",
      tool_error_code: "exa_invalid_urls",
    });
  });
});

describe("validateHostedToolEnvironment", () => {
  it("requires EXA_API_KEY only when an Exa provider tool is enabled", () => {
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
    ).toThrow(MissingEnvError);
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "exa_contents"],
        env: env({ exaApiKey: undefined }),
      }),
    ).toThrow(MissingEnvError);
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
    ampApiKey: undefined,
    codexApiKey: undefined,
    codexModel: "gpt-5.4",
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner-test",
    ...overrides,
  };
}
