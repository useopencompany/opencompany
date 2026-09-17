import { describe, expect, it } from "vitest";
import type { HeadlessChatRunReadModel } from "./headless-chat-collections";
import { selectActiveTaskRun } from "./task-conversation-activity";

const settledAt = "2026-09-17T15:16:34.320Z";

function run(overrides: Partial<HeadlessChatRunReadModel>): HeadlessChatRunReadModel {
  return {
    id: "run_1",
    conversationId: "conversation_1",
    triggerMessageId: "message_user_1",
    assistantMessageId: "message_assistant_1",
    status: "running",
    engine: "codex",
    model: "gpt-5.6-sol",
    attemptCount: 1,
    error: null,
    createdAt: "2026-09-17T15:13:27.984Z",
    updatedAt: "2026-09-17T15:16:04.100Z",
    ...overrides,
  };
}

describe("selectActiveTaskRun", () => {
  it("ignores a Run projection that still looks live after the Task settled", () => {
    expect(
      selectActiveTaskRun({ status: "succeeded", updatedAt: settledAt }, [run({})]),
    ).toBeNull();
    expect(
      selectActiveTaskRun({ status: "failed", updatedAt: new Date(settledAt) }, [
        run({ status: "paused" }),
        run({ id: "run_2", status: "queued", createdAt: "2026-09-17T15:14:00.000Z" }),
      ]),
    ).toBeNull();
  });

  it("follows a Run written after the Task settled: it is the Task's next turn", () => {
    const followUp = run({
      id: "run_2",
      status: "queued",
      createdAt: "2026-09-17T15:20:00.000Z",
      updatedAt: "2026-09-17T15:20:00.000Z",
    });
    expect(
      selectActiveTaskRun({ status: "succeeded", updatedAt: settledAt }, [run({}), followUp]),
    ).toBe(followUp);
  });

  it("prefers the working Run over a message queued behind it while the Task is live", () => {
    const working = run({});
    const queued = run({ id: "run_queued", status: "queued", createdAt: "2026-09-17T15:15:00Z" });
    expect(
      selectActiveTaskRun({ status: "running", updatedAt: settledAt }, [queued, working]),
    ).toBe(working);
    expect(selectActiveTaskRun({ status: "waiting", updatedAt: settledAt }, [queued])).toBe(queued);
  });
});
