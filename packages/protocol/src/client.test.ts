import { describe, expect, it, vi } from "vitest";
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

describe("protocol SSE client", () => {
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

  it("rejects an event from another Run", async () => {
    const wrongRun = { ...event(1), runId: "run_2" };
    const stream = streamRunEvents({
      baseUrl: "https://api.example.test",
      runId: "run_1",
      fetch: async () => new Response(`data: ${JSON.stringify(wrongRun)}\n\n`),
    });
    await expect(stream.next()).rejects.toThrow(/another Run/u);
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
