import type { RuntimeToolName } from "@opencompany/agent-runtime";
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

  it("searches X posts and records estimated read cost", async () => {
    const fetchMock = vi.fn(
      async (_url: URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "111",
                text: "AI agents are useful",
                author_id: "42",
                created_at: "2026-05-31T10:00:00.000Z",
                conversation_id: "111",
                public_metrics: {
                  like_count: 10,
                  reply_count: 2,
                  retweet_count: 1,
                  quote_count: 0,
                },
              },
            ],
            includes: {
              users: [
                {
                  id: "42",
                  username: "builder",
                  name: "Builder",
                  verified: true,
                  public_metrics: { followers_count: 100 },
                },
              ],
            },
            meta: { result_count: 1, next_token: "next" },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "x_search_posts",
      args: { query: "AI agents", mode: "recent", maxResults: 20, paginationToken: "page" },
      env: env(),
      enabledTools: ["tool_help", "x_search_posts"],
      signal: new AbortController().signal,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain("https://api.x.com/2/tweets/search/recent?");
    expect(url.searchParams.get("query")).toBe("AI agents");
    expect(url.searchParams.get("max_results")).toBe("20");
    expect(url.searchParams.get("next_token")).toBe("page");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer x_test",
      Accept: "application/json",
    });
    expect(result.output).toMatchObject({
      posts: [
        {
          id: "111",
          url: "https://x.com/builder/status/111",
          text: "AI agents are useful",
          author: { id: "42", username: "builder", name: "Builder", verified: true },
          metrics: { likeCount: 10, replyCount: 2, retweetCount: 1, quoteCount: 0 },
          conversationId: "111",
        },
      ],
      nextToken: "next",
    });
    expect(result.usage).toMatchObject({
      provider: "x",
      operation: "search_posts",
      costUsdMicros: 15_000,
      rawUsage: { estimated: true, postsRead: 1, usersRead: 1 },
    });
  });

  it("defaults X post searches to 10 results when maxResults is omitted", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], meta: { result_count: 0 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await executeHostedTool({
      name: "x_search_posts",
      args: { query: "AI agents" },
      env: env(),
      enabledTools: ["tool_help", "x_search_posts"],
      signal: new AbortController().signal,
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("max_results")).toBe("10");
  });

  it("gets an X profile by username", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              id: "42",
              username: "builder",
              name: "Builder",
              description: "Building",
              verified: false,
              is_identity_verified: true,
              public_metrics: { followers_count: 100, tweet_count: 12 },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "x_get_profile",
      args: { username: "@builder" },
      env: env(),
      enabledTools: ["tool_help", "x_get_profile"],
      signal: new AbortController().signal,
    });

    const firstCall = fetchMock.mock.calls[0] as unknown as [URL, RequestInit] | undefined;
    if (!firstCall) throw new Error("Expected X profile fetch to be called");
    const [url] = firstCall;
    expect(url.toString()).toContain("/2/users/by/username/builder?");
    expect(result.output).toMatchObject({
      user: {
        id: "42",
        username: "builder",
        description: "Building",
        isIdentityVerified: true,
        metrics: { followersCount: 100, postCount: 12 },
      },
    });
    expect(result.usage).toMatchObject({
      provider: "x",
      operation: "get_profile",
      costUsdMicros: 10_000,
      rawUsage: { estimated: true, usersRead: 1 },
    });
  });

  it("gets X user posts after resolving the username", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: "42", username: "builder", name: "Builder" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "222", text: "Shipping", author_id: "42" }],
            includes: { users: [{ id: "42", username: "builder", name: "Builder" }] },
            meta: { result_count: 1 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "x_get_user_posts",
      args: { username: "builder", maxResults: 12, excludeReplies: true },
      env: env(),
      enabledTools: ["tool_help", "x_get_user_posts"],
      signal: new AbortController().signal,
    });

    const [secondUrl, secondInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(secondUrl.toString()).toContain("/2/users/42/tweets?");
    expect(secondUrl.searchParams.get("max_results")).toBe("12");
    expect(secondUrl.searchParams.get("exclude")).toBe("replies");
    expect(secondInit.headers).toMatchObject({ Authorization: "Bearer x_test" });
    expect(result.output).toMatchObject({
      user: { id: "42", username: "builder" },
      posts: [{ id: "222", text: "Shipping" }],
    });
    expect(result.usage).toMatchObject({
      operation: "get_user_posts",
      costUsdMicros: 15_000,
    });
  });

  it("defaults X user timelines to 10 results when maxResults is omitted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: "42", username: "builder", name: "Builder" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], meta: { result_count: 0 } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await executeHostedTool({
      name: "x_get_user_posts",
      args: { username: "builder" },
      env: env(),
      enabledTools: ["tool_help", "x_get_user_posts"],
      signal: new AbortController().signal,
    });

    const [timelineUrl] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(timelineUrl.searchParams.get("max_results")).toBe("10");
  });

  it("gets an X discussion with target post, replies, and quote posts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "111",
              text: "Original",
              author_id: "42",
              conversation_id: "111",
            },
            includes: { users: [{ id: "42", username: "builder", name: "Builder" }] },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: "111", text: "Original", author_id: "42", conversation_id: "111" },
              {
                id: "112",
                text: "Reply",
                author_id: "43",
                conversation_id: "111",
                in_reply_to_user_id: "42",
              },
            ],
            includes: {
              users: [
                { id: "42", username: "builder", name: "Builder" },
                { id: "43", username: "reply", name: "Reply" },
              ],
            },
            meta: { result_count: 2 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "113", text: "Quote", author_id: "44", conversation_id: "113" }],
            includes: { users: [{ id: "44", username: "quote", name: "Quote" }] },
            meta: { result_count: 1 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "x_get_discussion",
      args: { postIdOrUrl: "https://x.com/builder/status/111", maxResults: 20 },
      env: env(),
      enabledTools: ["tool_help", "x_get_discussion"],
      signal: new AbortController().signal,
    });

    const [repliesUrl] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    const [quotesUrl] = fetchMock.mock.calls[2] as unknown as [URL, RequestInit];
    expect(repliesUrl.searchParams.get("query")).toBe("conversation_id:111 -is:retweet");
    expect(quotesUrl.toString()).toContain("/2/tweets/111/quote_tweets?");
    expect(result.output).toMatchObject({
      targetPost: { id: "111", text: "Original" },
      conversationId: "111",
      replies: [{ id: "112", text: "Reply", inReplyToUserId: "42" }],
      quotePosts: [{ id: "113", text: "Quote" }],
    });
    expect(result.usage).toMatchObject({
      operation: "get_discussion",
      costUsdMicros: 45_000,
      rawUsage: { postsRead: 3, usersRead: 3 },
    });
  });

  it("defaults X discussion replies and quote posts to 10 results when maxResults is omitted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "111",
              text: "Original",
              author_id: "42",
              conversation_id: "111",
            },
            includes: { users: [{ id: "42", username: "builder", name: "Builder" }] },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], meta: { result_count: 0 } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], meta: { result_count: 0 } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await executeHostedTool({
      name: "x_get_discussion",
      args: { postIdOrUrl: "https://x.com/builder/status/111" },
      env: env(),
      enabledTools: ["tool_help", "x_get_discussion"],
      signal: new AbortController().signal,
    });

    const repliesUrl = fetchMock.mock.calls[1]?.[0] as URL;
    const quotesUrl = fetchMock.mock.calls[2]?.[0] as URL;
    expect(repliesUrl.searchParams.get("max_results")).toBe("10");
    expect(quotesUrl.searchParams.get("max_results")).toBe("10");
  });

  it("gets X trends by WOEID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { trend_name: "#AI", tweet_count: 1000 },
                { trend_name: "OpenCompany", tweet_count: 500 },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await executeHostedTool({
      name: "x_get_trends",
      args: { woeid: 23424977, maxResults: 1 },
      env: env(),
      enabledTools: ["tool_help", "x_get_trends"],
      signal: new AbortController().signal,
    });

    expect(result.output).toEqual({
      woeid: 23424977,
      trends: [
        {
          name: "#AI",
          postCount: 1000,
          url: "https://x.com/search?q=%23AI&src=trend_click",
        },
      ],
    });
    expect(result.usage).toMatchObject({
      provider: "x",
      operation: "get_trends",
      costUsdMicros: 10_000,
      rawUsage: { trendsRead: 1, estimated: true },
    });
  });

  it("defaults X trends to 10 results when maxResults is omitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: Array.from({ length: 12 }, (_, index) => ({
                trend_name: `Trend ${index + 1}`,
                tweet_count: index + 1,
              })),
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await executeHostedTool({
      name: "x_get_trends",
      args: {},
      env: env(),
      enabledTools: ["tool_help", "x_get_trends"],
      signal: new AbortController().signal,
    });

    expect(result.output).toMatchObject({
      woeid: 1,
      trends: expect.arrayContaining([expect.objectContaining({ name: "Trend 10" })]),
    });
    expect((result.output as { trends: unknown[] }).trends).toHaveLength(10);
    expect(result.usage).toMatchObject({
      provider: "x",
      operation: "get_trends",
      costUsdMicros: 100_000,
      rawUsage: { trendsRead: 10, estimated: true },
    });
  });

  it("explains full-archive X search access failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ title: "Forbidden" }), {
            status: 403,
          }),
      ),
    );

    await expect(
      executeHostedTool({
        name: "x_search_posts",
        args: { query: "AI agents", mode: "all" },
        env: env(),
        enabledTools: ["tool_help", "x_search_posts"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("full-archive search and requires elevated API access");
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

  it("find_tools lists a capability compactly and points at tool_help", async () => {
    const result = await executeHostedTool({
      name: "find_tools",
      args: { capability: "exa" },
      env: env(),
      enabledTools: ["find_tools", "tool_help", "exa_search", "exa_contents", "exa_answer"],
      signal: new AbortController().signal,
    });
    const output = result.output as {
      toolCount: number;
      useTool: string;
      toolHelp: string;
      tools: Array<Record<string, unknown>>;
    };
    expect(output.useTool).toBe("use_tool");
    expect(output.toolHelp).toBe("tool_help");
    expect(output.toolCount).toBe(output.tools.length);
    expect(output.tools.map((tool) => tool.name)).toContain("exa_search");
    // Compact entries only — the verbose per-tool help is reachable via tool_help, not here.
    for (const tool of output.tools) {
      expect(tool).not.toHaveProperty("help");
    }
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

  it("classifies X validation, rate-limit, missing-token, and malformed-response failures", () => {
    expect(
      getHostedToolFailureContext({
        name: "x_get_profile",
        args: { username: "not valid!" },
        error: new Error("X username must be 1-15 letters, numbers, or underscores."),
      }),
    ).toMatchObject({
      hosted_provider: "x",
      hosted_operation: "get_profile",
      tool_error_stage: "request_validation",
      tool_error_code: "x_invalid_request",
    });
    expect(
      getHostedToolFailureContext({
        name: "x_search_posts",
        args: { query: "test" },
        error: new Error("X search_posts failed (429): Too Many Requests"),
      }),
    ).toMatchObject({
      hosted_provider: "x",
      hosted_operation: "search_posts",
      tool_error_stage: "provider_response",
      tool_error_code: "x_rate_limited",
      provider_status: 429,
    });
    expect(
      getHostedToolFailureContext({
        name: "x_get_trends",
        args: {},
        error: new Error("X_API_BEARER_TOKEN is required for x_get_trends."),
      }),
    ).toMatchObject({
      tool_error_stage: "configuration",
      tool_error_code: "x_missing_bearer_token",
    });
    expect(
      getHostedToolFailureContext({
        name: "x_get_trends",
        args: {},
        error: new Error("X get_trends returned an unexpected response shape."),
      }),
    ).toMatchObject({
      tool_error_stage: "provider_response",
      tool_error_code: "x_malformed_response",
    });
  });

  it("classifies YouTube validation, HTTP, rate-limit, missing-key, and malformed-response failures", () => {
    expect(
      getHostedToolFailureContext({
        name: "youtube_get_transcript",
        args: { url: "https://youtube.com/watch?v=abc", videoId: "def" },
        error: new Error("YouTube get_transcript accepts either url or videoId, not both."),
      }),
    ).toMatchObject({
      hosted_provider: "youtube",
      hosted_operation: "get_transcript",
      tool_error_stage: "request_validation",
      tool_error_code: "youtube_invalid_request",
    });
    expect(
      getHostedToolFailureContext({
        name: "youtube_get_video",
        args: { id: "missing" },
        error: new Error("YouTube get_video failed (404): Not Found"),
      }),
    ).toMatchObject({
      hosted_provider: "youtube",
      hosted_operation: "get_video",
      tool_error_stage: "provider_response",
      tool_error_code: "youtube_not_found",
      provider_status: 404,
    });
    expect(
      getHostedToolFailureContext({
        name: "youtube_search",
        args: { query: "test" },
        error: new Error("YouTube search failed (429): Too Many Requests"),
      }),
    ).toMatchObject({
      hosted_provider: "youtube",
      hosted_operation: "search",
      tool_error_stage: "provider_response",
      tool_error_code: "youtube_rate_limited",
      provider_status: 429,
    });
    expect(
      getHostedToolFailureContext({
        name: "youtube_get_channel",
        args: { id: "channel" },
        error: new Error("YouTube get_channel failed (503): Service Unavailable"),
      }),
    ).toMatchObject({
      hosted_provider: "youtube",
      hosted_operation: "get_channel",
      tool_error_stage: "provider_response",
      tool_error_code: "youtube_http_error",
      provider_status: 503,
    });
    expect(
      getHostedToolFailureContext({
        name: "youtube_get_transcript",
        args: {},
        error: new Error("SUPADATA_API_KEY is required for youtube get_transcript."),
      }),
    ).toMatchObject({
      tool_error_stage: "configuration",
      tool_error_code: "youtube_missing_api_key",
    });
    expect(
      getHostedToolFailureContext({
        name: "youtube_list_channel_videos",
        args: { id: "channel" },
        error: new Error("YouTube list_channel_videos returned an unexpected response shape."),
      }),
    ).toMatchObject({
      tool_error_stage: "provider_response",
      tool_error_code: "youtube_malformed_response",
    });
  });

  it("classifies TikTok and Instagram Supadata failures", () => {
    expect(
      getHostedToolFailureContext({
        name: "tiktok_get_transcript",
        args: {},
        error: new Error("TikTok get_transcript requires either url or jobId."),
      }),
    ).toMatchObject({
      hosted_provider: "tiktok",
      hosted_operation: "get_transcript",
      tool_error_stage: "request_validation",
      tool_error_code: "tiktok_invalid_request",
    });
    expect(
      getHostedToolFailureContext({
        name: "instagram_get_metadata",
        args: { url: "https://www.tiktok.com/@user/video/1" },
        error: new Error("Instagram URL must be a public Instagram URL."),
      }),
    ).toMatchObject({
      hosted_provider: "instagram",
      hosted_operation: "get_metadata",
      tool_error_stage: "request_validation",
      tool_error_code: "instagram_invalid_request",
    });
    expect(
      getHostedToolFailureContext({
        name: "tiktok_get_metadata",
        args: { url: "https://www.tiktok.com/@user/video/1" },
        error: new Error("TikTok get_metadata failed (404): Not Found"),
      }),
    ).toMatchObject({
      hosted_provider: "tiktok",
      hosted_operation: "get_metadata",
      tool_error_stage: "provider_response",
      tool_error_code: "tiktok_not_found",
      provider_status: 404,
    });
    expect(
      getHostedToolFailureContext({
        name: "instagram_get_transcript",
        args: { url: "https://www.instagram.com/reel/ABC123/" },
        error: new Error("Instagram get_transcript failed (429): Too Many Requests"),
      }),
    ).toMatchObject({
      hosted_provider: "instagram",
      hosted_operation: "get_transcript",
      tool_error_stage: "provider_response",
      tool_error_code: "instagram_rate_limited",
      provider_status: 429,
    });
    expect(
      getHostedToolFailureContext({
        name: "instagram_get_metadata",
        args: { url: "https://www.instagram.com/reel/ABC123/" },
        error: new Error("Instagram get_metadata failed (503): Service Unavailable"),
      }),
    ).toMatchObject({
      hosted_provider: "instagram",
      hosted_operation: "get_metadata",
      tool_error_stage: "provider_response",
      tool_error_code: "instagram_http_error",
      provider_status: 503,
    });
    expect(
      getHostedToolFailureContext({
        name: "tiktok_get_transcript",
        args: {},
        error: new Error("SUPADATA_API_KEY is required for tiktok get_transcript."),
      }),
    ).toMatchObject({
      tool_error_stage: "configuration",
      tool_error_code: "tiktok_missing_api_key",
    });
    expect(
      getHostedToolFailureContext({
        name: "instagram_get_metadata",
        args: { url: "https://www.instagram.com/reel/ABC123/" },
        error: new Error("Instagram get_metadata returned an unexpected response shape."),
      }),
    ).toMatchObject({
      tool_error_stage: "provider_response",
      tool_error_code: "instagram_malformed_response",
    });
  });
});

describe("executeHostedTool (YouTube)", () => {
  it("searches YouTube with Supadata defaults and normalizes results", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                type: "video",
                id: "dQw4w9WgXcQ",
                title: "Never Gonna Give You Up",
                description: "Official video",
                thumbnail: "https://img.youtube.com/x.jpg",
                duration: 213,
                viewCount: 1600000000,
                uploadDate: "2009-10-25T00:00:00Z",
                channel: { id: "UC123", name: "Rick Astley" },
              },
            ],
            nextPageToken: "next",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "youtube_search",
      args: { query: "rick astley" },
      env: env(),
      enabledTools: ["tool_help", "youtube_search"],
      signal: new AbortController().signal,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toContain("https://api.supadata.ai/v1/youtube/search?");
    expect(url.searchParams.get("query")).toBe("rick astley");
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(init.headers).toMatchObject({ "x-api-key": "supadata_test" });
    expect(result.output).toMatchObject({
      query: "rick astley",
      results: [
        {
          type: "video",
          id: "dQw4w9WgXcQ",
          title: "Never Gonna Give You Up",
          channel: { id: "UC123", name: "Rick Astley" },
        },
      ],
      nextPageToken: "next",
    });
    expect(result.usage).toMatchObject({ provider: "youtube", operation: "search" });
  });

  it("fetches a transcript by videoId as plain text", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: "We're no strangers to love",
            lang: "en",
            availableLangs: ["en", "es"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "youtube_get_transcript",
      args: { videoId: "dQw4w9WgXcQ" },
      env: env(),
      enabledTools: ["tool_help", "youtube_get_transcript"],
      signal: new AbortController().signal,
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toContain("https://api.supadata.ai/v1/transcript?");
    expect(url.searchParams.get("videoId")).toBe("dQw4w9WgXcQ");
    expect(url.searchParams.get("text")).toBe("true");
    expect(result.output).toEqual({
      content: "We're no strangers to love",
      lang: "en",
      availableLangs: ["en", "es"],
    });
    expect(result.usage).toMatchObject({ provider: "youtube", operation: "get_transcript" });
  });

  it("rejects transcript requests without a url or videoId", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeHostedTool({
        name: "youtube_get_transcript",
        args: {},
        env: env(),
        enabledTools: ["tool_help", "youtube_get_transcript"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/requires either url or videoId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects transcript requests that pass both url and videoId", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeHostedTool({
        name: "youtube_get_transcript",
        args: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "different" },
        env: env(),
        enabledTools: ["tool_help", "youtube_get_transcript"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/accepts either url or videoId, not both/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("executeHostedTool (TikTok and Instagram)", () => {
  it("fetches TikTok metadata through Supadata's universal metadata endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            platform: "tiktok",
            type: "video",
            id: "123",
            url: "https://www.tiktok.com/@user/video/123",
            title: null,
            description: "Launch recap",
            author: {
              displayName: "User",
              username: "user",
              avatarUrl: "https://example.com/avatar.jpg",
              verified: true,
            },
            stats: { views: 1000, likes: 100, comments: 10, shares: 5 },
            media: { type: "video", duration: 30, thumbnailUrl: "https://example.com/thumb.jpg" },
            tags: ["launch"],
            createdAt: "2026-01-01T00:00:00Z",
            additionalData: { music: "original" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "tiktok_get_metadata",
      args: { url: "https://www.tiktok.com/@user/video/123" },
      env: env(),
      enabledTools: ["tool_help", "tiktok_get_metadata"],
      signal: new AbortController().signal,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toContain("https://api.supadata.ai/v1/metadata?");
    expect(url.searchParams.get("url")).toBe("https://www.tiktok.com/@user/video/123");
    expect(init.headers).toMatchObject({ "x-api-key": "supadata_test" });
    expect(result.output).toMatchObject({
      metadata: {
        platform: "tiktok",
        type: "video",
        id: "123",
        description: "Launch recap",
        author: { username: "user", verified: true },
        stats: { views: 1000, likes: 100 },
        tags: ["launch"],
      },
    });
    expect(result.usage).toMatchObject({ provider: "tiktok", operation: "get_metadata" });
  });

  it("fetches an Instagram transcript and passes transcript options", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [{ text: "Welcome", offset: 0, duration: 500, lang: "en" }],
            lang: "en",
            availableLangs: ["en"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "instagram_get_transcript",
      args: {
        url: "https://www.instagram.com/reel/ABC123/",
        text: false,
        lang: "en",
        mode: "native",
        chunkSize: 40,
      },
      env: env(),
      enabledTools: ["tool_help", "instagram_get_transcript"],
      signal: new AbortController().signal,
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toContain("https://api.supadata.ai/v1/transcript?");
    expect(url.searchParams.get("url")).toBe("https://www.instagram.com/reel/ABC123/");
    expect(url.searchParams.get("text")).toBe("false");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("mode")).toBe("native");
    expect(url.searchParams.get("chunkSize")).toBe("50");
    expect(result.output).toEqual({
      content: [{ text: "Welcome", offset: 0, duration: 500, lang: "en" }],
      lang: "en",
      availableLangs: ["en"],
    });
    expect(result.usage).toMatchObject({ provider: "instagram", operation: "get_transcript" });
  });

  it("returns Supadata transcript job IDs and polls job results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job_123" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            content: "Generated transcript",
            lang: "en",
            availableLangs: ["en"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const created = await executeHostedTool({
      name: "tiktok_get_transcript",
      args: { url: "https://vm.tiktok.com/abc/", mode: "generate" },
      env: env(),
      enabledTools: ["tool_help", "tiktok_get_transcript"],
      signal: new AbortController().signal,
    });
    const polled = await executeHostedTool({
      name: "tiktok_get_transcript",
      args: { jobId: "job_123" },
      env: env(),
      enabledTools: ["tool_help", "tiktok_get_transcript"],
      signal: new AbortController().signal,
    });

    const [createUrl] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const [pollUrl] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(createUrl.pathname).toBe("/v1/transcript");
    expect(createUrl.searchParams.get("mode")).toBe("generate");
    expect(pollUrl.pathname).toBe("/v1/transcript/job_123");
    expect(created.output).toEqual({ status: "processing", jobId: "job_123" });
    expect(polled.output).toEqual({
      status: "completed",
      content: "Generated transcript",
      lang: "en",
      availableLangs: ["en"],
    });
    expect(polled.usage).toMatchObject({ provider: "tiktok", operation: "poll_transcript" });
  });

  it("rejects wrong-platform and ambiguous transcript requests before calling Supadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeHostedTool({
        name: "instagram_get_metadata",
        args: { url: "https://www.tiktok.com/@user/video/123" },
        env: env(),
        enabledTools: ["tool_help", "instagram_get_metadata"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Instagram URL must be a public Instagram URL/);
    await expect(
      executeHostedTool({
        name: "tiktok_get_transcript",
        args: { url: "https://www.tiktok.com/@user/video/123", jobId: "job_123" },
        env: env(),
        enabledTools: ["tool_help", "tiktok_get_transcript"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/accepts either url or jobId, not both/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects social profile URLs before calling Supadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeHostedTool({
        name: "instagram_get_metadata",
        args: { url: "https://www.instagram.com/openai/" },
        env: env(),
        enabledTools: ["tool_help", "instagram_get_metadata"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Instagram profile handles and profile URLs are not supported/);
    await expect(
      executeHostedTool({
        name: "instagram_get_metadata",
        args: { url: "https://www.instagram.com/openai/reels/" },
        env: env(),
        enabledTools: ["tool_help", "instagram_get_metadata"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Instagram profile handles and profile URLs are not supported/);
    await expect(
      executeHostedTool({
        name: "tiktok_get_metadata",
        args: { url: "https://www.tiktok.com/@openai" },
        env: env(),
        enabledTools: ["tool_help", "tiktok_get_metadata"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/TikTok profile handles and profile URLs are not supported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and normalizes an Instagram profile through Apify", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: "ig_123",
              username: "openai",
              full_name: "OpenAI",
              biography: "Research and deployment",
              is_verified: true,
              profile_pic_url_hd: "https://example.com/openai.jpg",
              external_url: "https://openai.com",
              followers: 1000,
              following: 12,
              post_count: 42,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "instagram_get_profile",
      args: { username: "@openai" },
      env: env(),
      enabledTools: ["tool_help", "instagram_get_profile"],
      signal: new AbortController().signal,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toContain(
      "https://api.apify.com/v2/acts/instagram-scraper~instagram-profile-scraper/run-sync-get-dataset-items",
    );
    expect(url.searchParams.get("token")).toBe("apify_test");
    expect(JSON.parse(String(init.body))).toEqual({ instagramUsernames: ["openai"] });
    expect(result.output).toMatchObject({
      sourceProvider: "apify",
      sourceUrl: "https://www.instagram.com/openai/",
      profile: {
        platform: "instagram",
        id: "ig_123",
        username: "openai",
        displayName: "OpenAI",
        bio: "Research and deployment",
        verified: true,
        avatarUrl: "https://example.com/openai.jpg",
        externalUrls: ["https://openai.com"],
        stats: { followers: 1000, following: 12, posts: 42 },
        sourceProvider: "apify",
      },
    });
    expect(result.output).toMatchObject({ fetchedAt: expect.any(String) });
    expect(result.usage).toMatchObject({ provider: "instagram", operation: "get_profile" });
  });

  it("rejects profile URLs from the wrong social platform", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeHostedTool({
        name: "instagram_get_profile",
        args: { username: "https://www.tiktok.com/@openai" },
        env: env(),
        enabledTools: ["tool_help", "instagram_get_profile"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Instagram username must be a username, @handle, or profile URL/);
    await expect(
      executeHostedTool({
        name: "tiktok_get_profile",
        args: { username: "https://example.com/openai" },
        env: env(),
        enabledTools: ["tool_help", "tiktok_get_profile"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/TikTok username must be a username, @handle, or profile URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("constructs a TikTok profile-post request and normalizes nested videos", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              username: "openai",
              nickname: "OpenAI",
              videos: [
                {
                  id: "video_1",
                  text: "Launch day #ai @team",
                  webVideoUrl: "https://www.tiktok.com/@openai/video/123",
                  createTime: 1767225600,
                  playCount: 100,
                  diggCount: 20,
                  commentCount: 3,
                  shareCount: 4,
                  authorMeta: { name: "openai", nickName: "OpenAI", verified: true },
                },
              ],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHostedTool({
      name: "tiktok_list_profile_posts",
      args: { username: "https://www.tiktok.com/@openai", limit: 12 },
      env: env(),
      enabledTools: ["tool_help", "tiktok_list_profile_posts"],
      signal: new AbortController().signal,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toContain(
      "https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/run-sync-get-dataset-items",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      profiles: ["openai"],
      resultsPerPage: 12,
    });
    expect(result.output).toMatchObject({
      sourceProvider: "apify",
      sourceUrl: "https://www.tiktok.com/@openai",
      posts: [
        {
          platform: "tiktok",
          id: "video_1",
          url: "https://www.tiktok.com/@openai/video/123",
          caption: "Launch day #ai @team",
          author: { username: "openai", verified: true },
          stats: { views: 100, likes: 20, comments: 3, shares: 4 },
          hashtags: ["ai"],
          mentions: ["team"],
          sourceProvider: "apify",
        },
      ],
    });
  });

  it("starts and polls async Apify jobs with normalized completed output", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: "run_123" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { status: "SUCCEEDED" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "comment_1",
              text: "great reel",
              created_at: 1767225600,
              owner: { username: "reader", is_verified: false },
              likesCount: 2,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const started = await executeHostedTool({
      name: "instagram_get_comments",
      args: { url: "https://www.instagram.com/reel/ABC123/", limit: 25, runMode: "async" },
      env: env(),
      enabledTools: ["tool_help", "instagram_get_comments", "social_get_job"],
      signal: new AbortController().signal,
    });
    const jobId = (started.output as { jobId: string }).jobId;
    expect(jobId).toMatch(/^[^.]+\.[^.]+$/);
    const completed = await executeHostedTool({
      name: "social_get_job",
      args: { jobId },
      env: env(),
      enabledTools: ["tool_help", "social_get_job"],
      signal: new AbortController().signal,
    });

    const [startUrl, startInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(startUrl.pathname).toBe("/v2/acts/apify~instagram-api-scraper/runs");
    expect(JSON.parse(String(startInit.body))).toMatchObject({
      directUrls: ["https://www.instagram.com/reel/ABC123/"],
      resultsType: "comments",
      maxComments: 25,
    });
    const [pollUrl] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    const [datasetUrl] = fetchMock.mock.calls[2] as unknown as [URL, RequestInit];
    expect(pollUrl.pathname).toBe("/v2/actor-runs/run_123");
    expect(datasetUrl.pathname).toBe("/v2/actor-runs/run_123/dataset/items");
    expect(started.output).toMatchObject({ status: "processing", jobId: expect.any(String) });
    expect(completed.output).toMatchObject({
      status: "completed",
      sourceProvider: "apify",
      sourceUrl: "https://www.instagram.com/reel/ABC123/",
      comments: [
        {
          id: "comment_1",
          text: "great reel",
          author: { username: "reader", verified: false },
          stats: { likes: 2 },
          sourceProvider: "apify",
        },
      ],
    });
  });

  it("rejects tampered async Apify job ids before polling", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { id: "run_123" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const started = await executeHostedTool({
      name: "instagram_get_comments",
      args: { url: "https://www.instagram.com/reel/ABC123/", limit: 25, runMode: "async" },
      env: env(),
      enabledTools: ["tool_help", "instagram_get_comments", "social_get_job"],
      signal: new AbortController().signal,
    });
    const jobId = (started.output as { jobId: string }).jobId;
    const [, signature] = jobId.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({
        provider: "apify",
        platform: "instagram",
        operation: "get_comments",
        runId: "run_forged",
        limit: 25,
        sourceUrl: "https://www.instagram.com/reel/ABC123/",
      }),
      "utf8",
    ).toString("base64url");

    await expect(
      executeHostedTool({
        name: "social_get_job",
        args: { jobId: `${forgedBody}.${signature}` },
        env: env(),
        enabledTools: ["tool_help", "social_get_job"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/social_get_job jobId is invalid/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("requires X_API_BEARER_TOKEN only when an X provider tool is enabled", () => {
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help"],
        env: env({ xApiBearerToken: undefined }),
      }),
    ).not.toThrow();
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "x_search_posts"],
        env: env({ xApiBearerToken: undefined }),
      }),
    ).toThrow(MissingEnvError);
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "x_get_discussion"],
        env: env({ xApiBearerToken: undefined }),
      }),
    ).toThrow(MissingEnvError);
  });

  it("requires SUPADATA_API_KEY only when a Supadata-backed provider tool is enabled", () => {
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help"],
        env: env({ supadataApiKey: undefined }),
      }),
    ).not.toThrow();
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "youtube_search"],
        env: env({ supadataApiKey: undefined }),
      }),
    ).toThrow(MissingEnvError);
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "youtube_get_transcript"],
        env: env({ supadataApiKey: undefined }),
      }),
    ).toThrow(MissingEnvError);
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "tiktok_get_metadata"],
        env: env({ supadataApiKey: undefined }),
      }),
    ).toThrow(MissingEnvError);
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "instagram_get_transcript"],
        env: env({ supadataApiKey: undefined }),
      }),
    ).toThrow(MissingEnvError);
  });

  it("requires APIFY_API_TOKEN only when an Apify-backed social tool is enabled", () => {
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help"],
        env: env({ apifyApiToken: undefined }),
      }),
    ).not.toThrow();
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "instagram_get_profile"],
        env: env({ apifyApiToken: undefined }),
      }),
    ).toThrow(MissingEnvError);
    expect(() =>
      validateHostedToolEnvironment({
        enabledTools: ["tool_help", "tiktok_get_comments"],
        env: env({ apifyApiToken: undefined }),
      }),
    ).toThrow(MissingEnvError);
  });
});

describe("executeHostedTool (discover_capabilities)", () => {
  type DiscoverOutput = {
    capabilityCount: number;
    howToEnable: string;
    capabilities: Array<{
      id: string;
      status: "enabled" | "available" | "needs_setup";
      reason?: string;
      howToEnable: string;
    }>;
  };

  const discover = async (
    opts: {
      env?: RunnerEnv;
      enabledTools?: RuntimeToolName[];
      hasAttachedRepository?: boolean;
      args?: unknown;
    } = {},
  ): Promise<DiscoverOutput> => {
    const result = await executeHostedTool({
      name: "discover_capabilities",
      args: opts.args ?? {},
      env: opts.env ?? env(),
      enabledTools: opts.enabledTools ?? ["discover_capabilities"],
      signal: new AbortController().signal,
      hasAttachedRepository: opts.hasAttachedRepository ?? false,
    });
    return result.output as DiscoverOutput;
  };

  const status = (output: DiscoverOutput, id: string) =>
    output.capabilities.find((capability) => capability.id === id)?.status;

  it("reports platform capabilities as available when their credentials are present", async () => {
    const output = await discover();
    expect(status(output, "exa")).toBe("available");
    expect(status(output, "x")).toBe("available");
    expect(output.capabilityCount).toBe(output.capabilities.length);
    expect(output.howToEnable).toContain("ask_user_question");
    // Workspace-OAuth capabilities are excluded from v1 discovery.
    expect(output.capabilities.map((capability) => capability.id)).not.toContain("gmail");
    expect(output.capabilities.map((capability) => capability.id)).not.toContain("linear");
  });

  it("reports a capability as needs_setup when its platform credential is missing", async () => {
    const output = await discover({ env: env({ xApiBearerToken: undefined }) });
    expect(status(output, "x")).toBe("needs_setup");
    // exa is unaffected — its own credential is still present.
    expect(status(output, "exa")).toBe("available");
  });

  it("gates amp on an attached repository and leaves opencode available without one", async () => {
    const noRepo = await discover({ hasAttachedRepository: false });
    expect(status(noRepo, "amp")).toBe("needs_setup");
    expect(status(noRepo, "opencode")).toBe("available");

    const withRepo = await discover({ hasAttachedRepository: true });
    expect(status(withRepo, "amp")).toBe("available");
  });

  it("reports an already-enabled capability as enabled", async () => {
    const output = await discover({ enabledTools: ["discover_capabilities", "exa_search"] });
    expect(status(output, "exa")).toBe("enabled");
  });

  it("filters by query", async () => {
    const output = await discover({ args: { query: "video" } });
    expect(output.capabilities.length).toBeGreaterThan(0);
    expect(output.capabilities.map((capability) => capability.id)).toContain("youtube");
    expect(output.capabilities.map((capability) => capability.id)).not.toContain("exa");
  });
});

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "vag",
    openaiCodexApiKey: undefined,
    publicUrl: undefined,
    llmBrokerEnabled: true,
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa_test",
    xApiBearerToken: "x_test",
    apifyApiToken: "apify_test",
    supadataApiKey: "supadata_test",
    ampApiKey: undefined,
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    opencodeTimeoutMs: 1_200_000,
    toolArgRepairEnabled: false,
    jobLeaseTtlMs: 300_000,
    jobMaxLeaseBusyAttempts: 10,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner-test",
    ...overrides,
  };
}
