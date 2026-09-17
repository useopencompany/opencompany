import { afterEach, describe, expect, it, vi } from "vitest";
import { executeApiWikiCommand } from "./api-wiki-client";

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const base = {
  origin: "http://api.local/",
  token: "secret-token",
  workspaceId: "ws_1",
  actorId: "user_1",
  idempotencyKey: "agent-wiki:turn_1:call_1",
};

describe("executeApiWikiCommand", () => {
  afterEach(() => vi.restoreAllMocks());

  it("gives a bounded query longer than the API's 20-second model deadline", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          signal = init.signal as AbortSignal;
          await new Promise((resolve) => setTimeout(resolve, 21_000));
          return new Response(JSON.stringify({ data: { ok: true, result: { matches: [] } } }));
        }),
      );
      const result = executeApiWikiCommand({
        ...base,
        toolInput: { command: "query", query: "question" },
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts the command with bearer auth and the idempotency header", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ data: { ok: true, result: { action: "created" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const output = await executeApiWikiCommand({
      ...base,
      toolInput: { command: "write", path: "projects/plan", body: "# Plan" },
    });
    expect(output).toEqual({ ok: true, result: { action: "created" } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.local/internal/wiki/commands");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
    expect(headers["idempotency-key"]).toBe("agent-wiki:turn_1:call_1");
    expect(JSON.parse(init.body as string)).toEqual({
      userWorkosId: "user_1",
      workspaceId: "ws_1",
      command: { command: "write", path: "projects/plan", body: "# Plan" },
    });
  });

  it("returns a domain { ok: false } result without throwing", async () => {
    stubFetch(
      new Response(JSON.stringify({ data: { ok: false, error: 'No wiki page "x".' } }), {
        status: 200,
      }),
    );
    await expect(
      executeApiWikiCommand({ ...base, toolInput: { command: "read", pages: "x" } }),
    ).resolves.toEqual({ ok: false, error: 'No wiki page "x".' });
  });

  it("posts a selected wiki outside the command payload", async () => {
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          data: {
            ok: true,
            result: { nodes: [] },
            wikiContext: {
              wiki: { id: "wiki_leadership", name: "Leadership", slug: "leadership" },
              instructions: "Record a decision owner.",
            },
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      executeApiWikiCommand({
        ...base,
        wikiId: "leadership",
        toolInput: { command: "tree" },
      }),
    ).resolves.toMatchObject({
      wikiContext: {
        wiki: { id: "wiki_leadership" },
        instructions: "Record a decision owner.",
      },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      userWorkosId: "user_1",
      workspaceId: "ws_1",
      wikiId: "leadership",
      command: { command: "tree" },
    });
  });

  it("throws with the request id on a non-2xx response and never leaks the raw body", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ error: { code: "forbidden", message: "nope", requestId: "request_abc" } }),
        { status: 403, headers: { "x-request-id": "request_abc" } },
      ),
    );
    await expect(
      executeApiWikiCommand({
        ...base,
        toolInput: { command: "write", path: "p", body: "b" },
      }),
    ).rejects.toThrow(/nope.*request_abc/u);
  });

  it("aborts when the caller's signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(new Response("{}", { status: 200 }));
    await expect(
      executeApiWikiCommand({
        ...base,
        toolInput: { command: "tree" },
        signal: controller.signal,
      }),
    ).rejects.toBeTruthy();
  });
});
