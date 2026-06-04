import { DurableStream, stream } from "@durable-streams/client";
import { DurableStreamTestServer } from "@durable-streams/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Architecture spike for the Phase 3 Durable Streams pivot (see INSTANT_REFACTOR.md
 * → "Streaming architecture v2"). This is NOT wired into the runner/web yet — it
 * exists to de-risk the bet before we touch the launch-critical streaming path:
 *
 *   1. Our `RuntimeEventForStream` JSON (durable rows with numeric id + transient
 *      rows with id:null) round-trips cleanly over a Durable Stream.
 *   2. A consumer can catch up from the beginning, then RESUME from a persisted
 *      offset after a disconnect with no loss and no duplication — the property
 *      raw SSE cannot give us today.
 *   3. Live-tail delivers newly appended events to an open subscriber.
 *
 * Runs entirely in-process against @durable-streams/server (the reference server),
 * so it needs no Electric Cloud infra.
 *
 * Canonical client API learned here (the seam Phase 3 builds on):
 *   - producer: `DurableStream.create({ url, contentType: "application/json" })`
 *     then `append(JSON.stringify(event))` — one framed JSON message per append.
 *   - catch-up: `stream({ url, json: true, live: false, offset })` + `await res.json()`
 *     (accumulates framed items, resolves at upToDate); `offset: "-1"` = from start,
 *     `res.offset` = the opaque resume offset to persist.
 *   - live tail: `stream({ url, json: true, live: true, offset })` + `subscribeJson`.
 */

// A representative slice of the runner's RuntimeEventForStream wire shape: a
// durable message lifecycle (numeric id) interleaved with transient token deltas
// (id: null). Mirrors what apps/runner/src/events.ts publishes.
type WireEvent = {
  id: number | null;
  type: string;
  messageId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  transient?: boolean;
};

const SESSION_EVENTS: WireEvent[] = [
  { id: 1, type: "message.created", messageId: "msg_a", payload: { role: "assistant", status: "running" }, createdAt: "2026-06-04T10:00:00.000Z" },
  { id: null, type: "message.delta", messageId: "msg_a", payload: { delta: "Hel" }, createdAt: "2026-06-04T10:00:00.100Z", transient: true },
  { id: null, type: "message.delta", messageId: "msg_a", payload: { delta: "lo" }, createdAt: "2026-06-04T10:00:00.200Z", transient: true },
  { id: 2, type: "tool.started", messageId: "msg_a", payload: { toolCallId: "call_1", name: "bash" }, createdAt: "2026-06-04T10:00:00.300Z" },
  { id: null, type: "command.output", messageId: "msg_a", payload: { toolCallId: "call_1", delta: "$ ls\n" }, createdAt: "2026-06-04T10:00:00.400Z", transient: true },
  { id: 3, type: "tool.completed", messageId: "msg_a", payload: { toolCallId: "call_1", outputPreview: "file.ts" }, createdAt: "2026-06-04T10:00:00.500Z" },
  { id: 4, type: "message.completed", messageId: "msg_a", payload: { content: "Hello" }, createdAt: "2026-06-04T10:00:00.600Z" },
];

// With contentType "application/json", each append is ONE framed JSON message
// (no NDJSON newline — a trailing newline yields two JSON values per message and
// a PARSE_ERROR). The consumer gets one parsed item per append.
function jsonMessage(event: WireEvent): string {
  return JSON.stringify(event);
}

// The stream must be created with contentType "application/json" so the server
// frames each append as a JSON message; then a `live: false` read accumulates
// the framed items across batches via `res.json()` and resolves at `upToDate`.
const JSON_STREAM_CONTENT_TYPE = "application/json";

// Catch a stream up to its current end and return the items + the resume offset.
// `offset: "-1"` reads from the beginning; pass a persisted (opaque) offset to resume.
async function catchUp(
  url: string,
  offset = "-1",
): Promise<{ items: WireEvent[]; offset: string }> {
  const res = await stream<WireEvent>({ url, json: true, live: false, offset });
  const items = await res.json();
  return { items, offset: res.offset };
}

describe("Durable Streams architecture spike", () => {
  let server: DurableStreamTestServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  function streamUrl(name: string): string {
    return `${baseUrl}/${name}`;
  }

  it("round-trips the full RuntimeEventForStream model and catches up from the beginning", async () => {
    const url = streamUrl("session-roundtrip");
    const writer = await DurableStream.create({ url, contentType: JSON_STREAM_CONTENT_TYPE });
    for (const event of SESSION_EVENTS) {
      await writer.append(jsonMessage(event));
    }

    const { items } = await catchUp(url);

    expect(items.map((e) => [e.id, e.type])).toEqual(
      SESSION_EVENTS.map((e) => [e.id, e.type]),
    );
    // Transient deltas survive the wire with their flag intact.
    expect(items.filter((e) => e.transient === true)).toHaveLength(3);
    // The accumulated text deltas reconstruct the streamed assistant content.
    const streamedText = items
      .filter((e) => e.type === "message.delta")
      .map((e) => e.payload.delta)
      .join("");
    expect(streamedText).toBe("Hello");
  });

  it("resumes from a persisted offset after a disconnect with no loss or duplication", async () => {
    const url = streamUrl("session-resume");
    const writer = await DurableStream.create({ url, contentType: JSON_STREAM_CONTENT_TYPE });

    // First half of the turn streams in...
    const firstHalf = SESSION_EVENTS.slice(0, 4);
    for (const event of firstHalf) await writer.append(jsonMessage(event));

    // Consumer catches up, then "disconnects" — we persist its offset.
    const { items: seen, offset: savedOffset } = await catchUp(url);
    expect(seen).toHaveLength(firstHalf.length);

    // The rest of the turn arrives while the consumer is gone.
    const secondHalf = SESSION_EVENTS.slice(4);
    for (const event of secondHalf) await writer.append(jsonMessage(event));

    // Resume strictly after the saved offset: only the new events, in order.
    const { items: resumed } = await catchUp(url, savedOffset);

    expect(resumed.map((e) => e.type)).toEqual(secondHalf.map((e) => e.type));
    // No overlap with what we already had — the union reconstructs the whole turn exactly once.
    const all = [...seen, ...resumed];
    expect(all).toHaveLength(SESSION_EVENTS.length);
    expect(all.map((e) => e.type)).toEqual(SESSION_EVENTS.map((e) => e.type));
  });

  it("live-tails newly appended events to an open subscriber", async () => {
    const url = streamUrl("session-livetail");
    const writer = await DurableStream.create({ url, contentType: JSON_STREAM_CONTENT_TYPE });
    await writer.append(jsonMessage(SESSION_EVENTS[0]!));

    const received: WireEvent[] = [];
    const res = await stream<WireEvent>({ url, json: true, live: true });
    const unsubscribe = res.subscribeJson((batch) => {
      received.push(...batch.items);
    });

    // Append after the subscription is live; expect delivery without a re-read.
    await writer.append(jsonMessage(SESSION_EVENTS[1]!));
    await writer.append(jsonMessage(SESSION_EVENTS[2]!));

    await expect.poll(() => received.length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
    expect(received.map((e) => e.type)).toEqual([
      "message.created",
      "message.delta",
      "message.delta",
    ]);

    unsubscribe();
    res.cancel();
  });
});
