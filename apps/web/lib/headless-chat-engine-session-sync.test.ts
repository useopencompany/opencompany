import { afterEach, describe, expect, it, vi } from "vitest";

// The other collection tests replace the Electric collection with a stub. This one runs the real
// TanStack DB Electric collection against a scripted shape log, because the defect it guards is
// in how partial Electric updates are keyed on the client.
const fetchMock = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));

vi.mock("./headless-chat-api", () => ({
  createHeadlessChatApiFetch: vi.fn(() => fetchMock.fetch),
  headlessChatApiBaseUrl: vi.fn(() => "https://api.example.test"),
}));

import { getHeadlessChatEngineSession } from "./headless-chat-collections";

type ShapeMessage = Record<string, unknown>;

const SCHEMA = JSON.stringify({
  id: { type: "text", not_null: true, pk_index: 0 },
  conversationId: { type: "text", not_null: true },
  engine: { type: "text", not_null: true },
  status: { type: "text", not_null: true },
  activeRunId: { type: "text" },
  error: { type: "text" },
  updatedAt: { type: "timestamptz", not_null: true },
});

// A scripted Electric shape log: the initial snapshot, then one live batch. Live polls after the
// script is exhausted hang until the collection aborts them, like a real long poll.
function scriptedShapeFetch(batches: ShapeMessage[][]) {
  let served = 0;
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const index = served;
    if (index >= batches.length) {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    }
    served += 1;
    const isInitial = url.searchParams.get("offset") === "-1";
    const batch = batches[index] ?? [];
    const upToDate = batch.some((message) => {
      const headers = message.headers as { control?: string } | undefined;
      return headers?.control === "up-to-date";
    });
    return new Response(JSON.stringify(batch), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "electric-handle": "handle_1",
        "electric-offset": `${index + 1}_0`,
        "electric-cursor": String(index + 1),
        ...(upToDate ? { "electric-up-to-date": "true" } : {}),
        ...(isInitial ? { "electric-schema": SCHEMA } : {}),
      },
    });
  });
}

const upToDate = { headers: { control: "up-to-date", global_last_seen_lsn: "0" } };

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("engine session shape sync", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("applies a partial Electric update that only carries the physical runtime id", async () => {
    const conversationId = "conversation_partial_update";
    fetchMock.fetch.mockImplementation(
      scriptedShapeFetch([
        [
          {
            key: '"goat"."codex_chat_sessions"/"runtime_1"',
            headers: { operation: "insert" },
            value: {
              id: "runtime_1",
              conversationId,
              engine: "codex",
              status: "running",
              activeRunId: "run_1",
              error: null,
              updatedAt: "2026-09-18T08:36:53.000Z",
            },
          },
          upToDate,
        ],
        // Electric's default replica mode sends the primary key plus changed columns only. The
        // settled turn changes status and active_turn_id; the conversation id is not among them.
        [
          {
            key: '"goat"."codex_chat_sessions"/"runtime_1"',
            headers: { operation: "update" },
            value: {
              id: "runtime_1",
              status: "idle",
              activeRunId: null,
              updatedAt: "2026-09-18T08:39:26.971Z",
            },
          },
          upToDate,
        ],
      ]),
    );

    const collection = getHeadlessChatEngineSession(conversationId);
    cleanups.push(() => collection.cleanup());
    await collection.preload();

    const row = () =>
      collection.toArray.find((candidate) => candidate.conversationId === conversationId);
    await waitFor(() => row()?.status === "idle");

    expect(collection.toArray).toHaveLength(1);
    expect(row()).toMatchObject({
      id: "runtime_1",
      conversationId,
      status: "idle",
      activeRunId: null,
      updatedAt: "2026-09-18T08:39:26.971Z",
    });
  });
});
