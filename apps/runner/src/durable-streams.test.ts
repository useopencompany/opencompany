import { stream } from "@durable-streams/client";
import { DurableStreamTestServer } from "@durable-streams/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __resetDurableStreamsForTests,
  flushSessionStream,
  isDurableStreamsEnabled,
  publishToDurableStream,
  sessionStreamName,
} from "./durable-streams";
import type { RuntimeEventForStream } from "./events";

// Verifies the runner-side publisher (events.ts → publishToDurableStream) wires a
// session's runtime events onto its Durable Stream, runs in-process against the
// reference server (no Electric Cloud infra), and stays a no-op when unconfigured.

const SERVER = new DurableStreamTestServer({ port: 0 });
let baseUrl: string;

beforeAll(async () => {
  baseUrl = await SERVER.start();
});

afterAll(async () => {
  await SERVER.stop();
});

afterEach(() => {
  delete process.env.DURABLE_STREAMS_URL;
  delete process.env.DURABLE_STREAMS_TOKEN;
  __resetDurableStreamsForTests();
});

function durableEvent(id: number, type: string, payload: Record<string, unknown>): RuntimeEventForStream {
  return {
    id,
    sessionId: "ses_pub",
    messageId: "msg_a",
    type,
    payload,
    createdAt: new Date("2026-06-04T10:00:00.000Z"),
  } as RuntimeEventForStream;
}

function transientEvent(type: string, payload: Record<string, unknown>): RuntimeEventForStream {
  return {
    id: null,
    sessionId: "ses_pub",
    messageId: "msg_a",
    type,
    payload,
    createdAt: new Date("2026-06-04T10:00:00.100Z"),
    transient: true,
  } as RuntimeEventForStream;
}

type WireEvent = { id: number | null; type: string; transient?: boolean; payload: Record<string, unknown> };

async function readAll(sessionId: string): Promise<WireEvent[]> {
  const url = `${baseUrl}/${sessionStreamName(sessionId)}`;
  const res = await stream<WireEvent>({ url, json: true, live: false, offset: "-1" });
  return res.json();
}

describe("durable streams publisher", () => {
  it("is disabled (no-op) when DURABLE_STREAMS_URL is unset", () => {
    expect(isDurableStreamsEnabled()).toBe(false);
    // Must not throw even though streaming is unconfigured.
    expect(() => publishToDurableStream("ses_noop", transientEvent("message.delta", { delta: "x" }))).not.toThrow();
  });

  it("publishes durable + transient events to the session's stream in order", async () => {
    process.env.DURABLE_STREAMS_URL = baseUrl;
    const sessionId = "ses_pub";

    const events: RuntimeEventForStream[] = [
      durableEvent(1, "message.created", { role: "assistant", status: "running" }),
      transientEvent("message.delta", { delta: "Hel" }),
      transientEvent("message.delta", { delta: "lo" }),
      durableEvent(2, "tool.started", { toolCallId: "call_1", name: "bash" }),
      durableEvent(3, "message.completed", { content: "Hello" }),
    ];
    for (const event of events) publishToDurableStream(sessionId, event);
    await flushSessionStream(sessionId);

    await expect.poll(async () => (await readAll(sessionId)).length, { timeout: 5000 }).toBe(events.length);

    const items = await readAll(sessionId);
    expect(items.map((e) => [e.id, e.type])).toEqual([
      [1, "message.created"],
      [null, "message.delta"],
      [null, "message.delta"],
      [2, "tool.started"],
      [3, "message.completed"],
    ]);
    // Transient flag and payloads survive the wire (so the consumer can reduce them).
    expect(items.filter((e) => e.transient === true)).toHaveLength(2);
    expect(
      items.filter((e) => e.type === "message.delta").map((e) => e.payload.delta).join(""),
    ).toBe("Hello");
  });

  it("keeps separate sessions on separate streams", async () => {
    process.env.DURABLE_STREAMS_URL = baseUrl;
    publishToDurableStream("ses_one", durableEvent(1, "message.created", {}));
    publishToDurableStream("ses_two", durableEvent(9, "session.status", { status: "running" }));
    await flushSessionStream("ses_one");
    await flushSessionStream("ses_two");

    await expect.poll(async () => (await readAll("ses_one")).length, { timeout: 5000 }).toBe(1);
    await expect.poll(async () => (await readAll("ses_two")).length, { timeout: 5000 }).toBe(1);

    expect((await readAll("ses_one")).map((e) => e.type)).toEqual(["message.created"]);
    expect((await readAll("ses_two")).map((e) => e.type)).toEqual(["session.status"]);
  });
});
