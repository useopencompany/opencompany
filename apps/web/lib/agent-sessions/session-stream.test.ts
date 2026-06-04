// @vitest-environment node
// The Durable Streams SSE client needs real streaming fetch (jsdom's is
// incomplete); this consumer is framework-agnostic, so run it under node.
import { DurableStream } from "@durable-streams/client";
import { DurableStreamTestServer } from "@durable-streams/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeEvent, SessionRuntimeState } from "./runtime-events";
import { subscribeSessionStream } from "./session-stream";

// Validates the framework-agnostic stream consumer: it catches up a session's
// Durable Stream and live-tails it, folding events through applyRuntimeEventToState
// to rebuild the rendered transcript. Runs in-process against the reference server.

const JSON_CONTENT_TYPE = "application/json";
const SERVER = new DurableStreamTestServer({ port: 0 });
let baseUrl: string;

beforeAll(async () => {
  baseUrl = await SERVER.start();
});

afterAll(async () => {
  await SERVER.stop();
});

function streamUrl(sessionId: string): string {
  return `${baseUrl}/session-${sessionId}`;
}

// Mirror what the runner publisher writes: one framed JSON event per append.
// batching:false flushes each append immediately (the real runner uses an
// IdempotentProducer with auto-flush; this keeps the test deterministic).
async function producer(sessionId: string) {
  const handle = await DurableStream.create({
    url: streamUrl(sessionId),
    contentType: JSON_CONTENT_TYPE,
    batching: false,
  });
  let seq = 0;
  return {
    async append(event: Partial<RuntimeEvent> & { type: string; payload: Record<string, unknown> }) {
      seq += 1;
      const full: RuntimeEvent = {
        id: event.transient ? null : seq,
        type: event.type,
        messageId: event.messageId ?? null,
        payload: event.payload,
        createdAt: event.createdAt ?? `2026-06-04T10:00:00.${String(seq).padStart(3, "0")}Z`,
        ...(event.transient ? { transient: true } : {}),
      };
      await handle.append(JSON.stringify(full));
    },
  };
}

function findMessage(state: SessionRuntimeState | null, id: string) {
  return state?.messages.find((message) => message.id === id);
}

describe("subscribeSessionStream", () => {
  it("materializes a completed assistant turn from catch-up history", async () => {
    const sessionId = "catchup";
    const stream = await producer(sessionId);
    await stream.append({ type: "message.created", messageId: "msg_a", payload: { messageId: "msg_a", role: "assistant", status: "running" } });
    await stream.append({ type: "message.delta", messageId: "msg_a", transient: true, payload: { messageId: "msg_a", delta: "Hel" } });
    await stream.append({ type: "message.delta", messageId: "msg_a", transient: true, payload: { messageId: "msg_a", delta: "lo" } });
    await stream.append({ type: "message.completed", messageId: "msg_a", payload: { messageId: "msg_a", content: "Hello" } });

    let latest: SessionRuntimeState | null = null;
    const unsubscribe = subscribeSessionStream(streamUrl(sessionId), { onState: (state) => (latest = state) });

    await expect.poll(() => findMessage(latest, "msg_a")?.status, { timeout: 5000 }).toBe("completed");
    const message = findMessage(latest, "msg_a");
    expect(message?.role).toBe("assistant");
    expect(message?.content).toBe("Hello");
    // The durable + transient events both landed in the materialized state.
    expect(latest?.events.length).toBe(4);

    unsubscribe();
  });

  it("live-tails new events after catch-up (resumable in-flight streaming)", async () => {
    const sessionId = "livetail";
    const stream = await producer(sessionId);
    // Only the user turn + assistant start exist when the consumer connects.
    await stream.append({ type: "message.created", messageId: "msg_u", payload: { messageId: "msg_u", role: "user", content: "hi", status: "completed" } });
    await stream.append({ type: "message.created", messageId: "msg_b", payload: { messageId: "msg_b", role: "assistant", status: "running" } });

    let latest: SessionRuntimeState | null = null;
    const unsubscribe = subscribeSessionStream(streamUrl(sessionId), { onState: (state) => (latest = state) });

    await expect.poll(() => findMessage(latest, "msg_b")?.status, { timeout: 5000 }).toBe("running");

    // Tokens stream in live, then the message completes.
    await stream.append({ type: "message.delta", messageId: "msg_b", transient: true, payload: { messageId: "msg_b", delta: "Wor" } });
    await stream.append({ type: "message.delta", messageId: "msg_b", transient: true, payload: { messageId: "msg_b", delta: "ld" } });
    await stream.append({ type: "message.completed", messageId: "msg_b", payload: { messageId: "msg_b", content: "World" } });

    await expect.poll(() => findMessage(latest, "msg_b")?.content, { timeout: 5000 }).toBe("World");
    expect(findMessage(latest, "msg_b")?.status).toBe("completed");
    expect(findMessage(latest, "msg_u")?.content).toBe("hi");

    unsubscribe();
  });
});
