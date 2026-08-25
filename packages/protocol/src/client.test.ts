import { afterEach, describe, expect, it, vi } from "vitest";
import { sseDataFields, streamRunEvents } from "./client";

const event = (sequence: number, type = "message.content_updated") => ({
  id: `event_${sequence}`,
  runId: "run_1",
  attemptId: "attempt_1",
  cursor: `v1:${sequence}`,
  schemaVersion: 1,
  occurredAt: "2026-08-10T20:00:00.000Z",
  type,
  payload:
    type === "run.completed"
      ? { messageId: "message_2" }
      : { messageId: "message_2", content: `content ${sequence}`, complete: false },
});

const presentation = (cursor: string, delta = "Hi") => ({
  runId: "run_1",
  attemptNumber: 1,
  presentationCursor: cursor,
  schemaVersion: 1,
  occurredAt: "2026-08-10T20:00:00.000Z",
  type: "message.presentation_delta",
  payload: {
    messageId: "message_2",
    startOffset: 0,
    endOffset: delta.length,
    delta,
  },
});

describe("protocol SSE client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses chunked, multiline SSE data while ignoring heartbeats", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keep-alive\r\ndata: {"one":\r\n'));
        controller.enqueue(encoder.encode('data: 1}\r\n\r\ndata: {"two":2}\n\n'));
        controller.close();
      },
    });
    const values: string[] = [];
    for await (const value of sseDataFields(body)) values.push(value);
    expect(values).toEqual(['{"one":\n1}', '{"two":2}']);
  });

  it("reconnects with the last validated cursor and suppresses replayed events", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      calls.push(url.searchParams.get("cursor") ?? "");
      const events = calls.length === 1 ? [event(1)] : [event(1), event(2, "run.completed")];
      return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const cursors: string[] = [];
    const received = [];
    for await (const value of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: fetchMock as typeof fetch,
      onCursor: (cursor) => cursors.push(cursor),
      reconnectDelayMs: 0,
    })) {
      received.push(value.id);
    }
    expect(received).toEqual(["event_1", "event_2"]);
    expect(calls).toEqual(["", "v1:1"]);
    expect(cursors).toEqual(["v1:1", "v1:2"]);
  });

  it("reconnects from the last validated cursor when the response body throws", async () => {
    const encoder = new TextEncoder();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      calls.push(url.searchParams.get("cursor") ?? "");
      if (calls.length === 1) {
        let reads = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads += 1;
              if (reads === 1) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event(1))}\n\n`));
                return;
              }
              controller.error(new TypeError("Error in input stream"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(
        [event(1), event(2, "run.completed")]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });

    const received = [];
    for await (const value of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: fetchMock as typeof fetch,
      reconnectDelayMs: 0,
    })) {
      received.push(value.id);
    }

    expect(received).toEqual(["event_1", "event_2"]);
    expect(calls).toEqual(["", "v1:1"]);
  });

  it("retries transient fetch and retryable HTTP failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Temporarily unavailable.", retryable: true } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(`data: ${JSON.stringify(event(1, "run.completed"))}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

    const received = [];
    for await (const value of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: fetchMock,
      reconnectDelayMs: 0,
    })) {
      received.push(value.type);
    }

    expect(received).toEqual(["run.completed"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable HTTP or protocol failures", async () => {
    const unauthorizedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: "Authentication is required.", retryable: false } },
          { status: 401 },
        ),
      );
    const unauthorized = streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: unauthorizedFetch,
      reconnectDelayMs: 0,
    });
    await expect(unauthorized.next()).rejects.toThrow("Authentication is required.");
    expect(unauthorizedFetch).toHaveBeenCalledTimes(1);

    const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data: not-json\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const malformed = streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: malformedFetch,
      reconnectDelayMs: 0,
    });
    await expect(malformed.next()).rejects.toThrow("malformed JSON");
    expect(malformedFetch).toHaveBeenCalledTimes(1);
  });

  it("stops retrying immediately when aborted", async () => {
    const abortController = new AbortController();
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      abortController.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const received = [];
    for await (const value of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: fetchMock as typeof fetch,
      signal: abortController.signal,
      reconnectDelayMs: 0,
    })) {
      received.push(value);
    }

    expect(received).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces one stable error after transient reconnects are exhausted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const stream = streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: fetchMock,
      reconnectDelayMs: 0,
      maxReconnectAttempts: 2,
    });

    await expect(stream.next()).rejects.toThrow(
      "The Run event stream disconnected repeatedly before the Run finished.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("binds the default browser fetch to its runtime receiver", async () => {
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(`data: ${JSON.stringify(event(1, "run.completed"))}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const received = [];
    for await (const value of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
    })) {
      received.push(value.type);
    }

    expect(received).toEqual(["run.completed"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an event from another Run", async () => {
    const wrongRun = { ...event(1), runId: "run_2" };
    const stream = streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: async () => new Response(`data: ${JSON.stringify(wrongRun)}\n\n`),
    });
    await expect(stream.next()).rejects.toThrow(/another Run/u);
  });

  it("reconnects with independent durable and transient cursors", async () => {
    const calls: Array<{ durable: string; presentation: string }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      calls.push({
        durable: url.searchParams.get("cursor") ?? "",
        presentation: url.searchParams.get("presentationCursor") ?? "",
      });
      const events =
        calls.length === 1
          ? [event(1), presentation("p1:1786449600000-0")]
          : [event(2, "run.completed")];
      return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const presentationCursors: string[] = [];

    for await (const _event of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: fetchMock as typeof fetch,
      reconnectDelayMs: 0,
      onPresentationCursor: (cursor) => presentationCursors.push(cursor),
    })) {
      // Consume through the terminal durable event.
    }

    expect(calls).toEqual([
      { durable: "", presentation: "" },
      { durable: "v1:1", presentation: "p1:1786449600000-0" },
    ]);
    expect(presentationCursors).toEqual(["p1:1786449600000-0"]);
  });

  it("ends at a durable approval pause without reconnecting", async () => {
    const paused = {
      ...event(1),
      type: "run.paused",
      payload: { reason: "approval_required" },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(`data: ${JSON.stringify(paused)}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const received = [];
    for await (const value of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: fetchMock as typeof fetch,
    })) {
      received.push(value.type);
    }
    expect(received).toEqual(["run.paused"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues past a historical pause when replay includes its resolution", async () => {
    const paused = {
      ...event(1),
      type: "run.paused",
      payload: { reason: "approval_required" },
    };
    const resolved = {
      ...event(2),
      type: "approval.resolved",
      payload: { approvalId: "approval_1", resolution: "approved" },
    };
    const completed = event(3, "run.completed");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          [paused, resolved, completed]
            .map((value) => `data: ${JSON.stringify(value)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );

    const received = [];
    for await (const value of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: fetchMock as typeof fetch,
    })) {
      received.push(value.type);
    }
    expect(received).toEqual(["run.paused", "approval.resolved", "run.completed"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ends cleanly when the cursor already points at the terminal event", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("", {
          headers: {
            "Content-Type": "text/event-stream",
            "X-OpenCompany-Run-Status": "completed",
          },
        }),
    );

    const received = [];
    for await (const value of streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      cursor: "v1:3",
      fetch: fetchMock as typeof fetch,
    })) {
      received.push(value);
    }
    expect(received).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
