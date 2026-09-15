import { describe, expect, it } from "vitest";
import type { ChatUiMessage } from "@/lib/chat-ui";
import type { HeadlessChatRunReadModel } from "@/lib/headless-chat-collections";
import { pendingRunMessageIds, queuedChatMessages } from "./queued-messages";

function run(overrides: Partial<HeadlessChatRunReadModel>): HeadlessChatRunReadModel {
  return {
    id: "run_1",
    conversationId: "conversation_1",
    triggerMessageId: "message_user_1",
    assistantMessageId: "message_assistant_1",
    status: "queued",
    engine: "codex",
    model: "gpt-5.5-codex",
    attemptCount: 0,
    error: null,
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
    ...overrides,
  };
}

function message(id: string, text: string): ChatUiMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as ChatUiMessage;
}

function runs(...values: HeadlessChatRunReadModel[]) {
  return new Map(values.map((value) => [value.id, value] as const));
}

describe("queuedChatMessages", () => {
  it("lists messages waiting behind the running turn, oldest first", () => {
    const queued = queuedChatMessages({
      runs: runs(
        run({ id: "run_2", triggerMessageId: "message_2", createdAt: "2026-09-14T12:00:02.000Z" }),
        run({ id: "run_1", triggerMessageId: "message_1", createdAt: "2026-09-14T12:00:01.000Z" }),
        run({
          id: "run_active",
          triggerMessageId: "message_active",
          status: "running",
          attemptCount: 1,
        }),
      ),
      messages: [
        message("message_active", "Fix the failing build."),
        message("message_1", "Also update the changelog."),
        message("message_2", "And check the migration."),
      ],
    });

    expect(queued).toEqual([
      { runId: "run_1", text: "Also update the changelog." },
      { runId: "run_2", text: "And check the migration." },
    ]);
  });

  it("skips a queued run whose message has not synced yet", () => {
    // Electric can deliver the Run before its Message. An empty card is worse than no card.
    expect(
      queuedChatMessages({
        runs: runs(run({ triggerMessageId: "message_missing" })),
        messages: [],
      }),
    ).toEqual([]);
  });

  it("keeps an ordinary foreground Run in the transcript while it waits to be claimed", () => {
    expect(
      queuedChatMessages({
        runs: runs(run({ triggerMessageId: "message_1" })),
        messages: [message("message_1", "Start the migration.")],
      }),
    ).toEqual([]);
  });
});

describe("pendingRunMessageIds", () => {
  it("hides messages for runs that never executed", () => {
    const hidden = pendingRunMessageIds({
      runs: runs(
        run({
          id: "run_active",
          triggerMessageId: "message_active",
          assistantMessageId: "assistant_active",
          status: "running",
          attemptCount: 1,
        }),
        run({ id: "run_queued", triggerMessageId: "message_q", assistantMessageId: "assistant_q" }),
        run({
          id: "run_steered",
          triggerMessageId: "message_s",
          assistantMessageId: "assistant_s",
          status: "canceled",
        }),
      ),
      messages: [],
    });

    expect([...hidden].toSorted()).toEqual([
      "assistant_q",
      "assistant_s",
      "message_q",
      "message_s",
    ]);
  });

  it("keeps a run the user stopped after it had already started", () => {
    // A turn that produced output stays in the transcript even though it was canceled.
    expect(
      pendingRunMessageIds({
        runs: runs(run({ status: "canceled", attemptCount: 1 })),
        messages: [],
      }).size,
    ).toBe(0);
  });

  it("keeps an ordinary queued foreground message in the transcript", () => {
    expect(
      pendingRunMessageIds({
        runs: runs(run({ triggerMessageId: "message_1" })),
        messages: [],
      }).size,
    ).toBe(0);
  });
});
