import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import { createGoatCodexChatProjector } from "./goat-codex-chat-events";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: mocks.captureException,
}));

vi.mock("./db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

describe("createGoatCodexChatProjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps projecting a valid event when its auxiliary audit insert fails", async () => {
    const databaseError = Object.assign(new Error("query details must not be reported"), {
      code: "23514",
    });
    mocks.execute
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ rows: [{ id: "goat_chat_msg_assistant_1" }] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await expect(projector.push([fileChangeStartedEvent()])).resolves.toBeUndefined();

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "GoatCodexChatEventPersistenceError",
        message: "Goat Codex chat audit event persistence failed.",
      }),
      expect.objectContaining({
        event: "opencompany.goat_codex_chat_event_persist_failed",
        turn_id: "goat_codex_chat_turn_1",
        event_type: "file_change.started",
        original_error_code: "23514",
      }),
    );
    expect(mocks.captureException.mock.calls[0]?.[0]).not.toBe(databaseError);
  });

  it("still aborts projection when the event insert proves the turn lease was lost", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await expect(projector.push([fileChangeStartedEvent()])).rejects.toBeInstanceOf(
      GoatCodexChatLeaseLostError,
    );

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("reports audit failures safely when an error has a cyclic cause", async () => {
    const cyclicError = new Error("cyclic query error") as Error & { cause?: unknown };
    cyclicError.cause = cyclicError;
    mocks.execute
      .mockRejectedValueOnce(cyclicError)
      .mockResolvedValueOnce({ rows: [{ id: "goat_chat_msg_assistant_1" }] });
    const projector = createGoatCodexChatProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await expect(projector.push([fileChangeStartedEvent()])).resolves.toBeUndefined();

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ original_error_code: undefined }),
    );
  });
});

function projectorTarget() {
  return {
    userWorkosId: "user_1",
    codexChatSessionId: "goat_codex_chat_1",
    chatSessionId: "goat_chat_1",
    turnId: "goat_codex_chat_turn_1",
    assistantMessageId: "goat_chat_msg_assistant_1",
    model: "gpt-5.5",
    leaseId: "goat_codex_chat_lease_1",
    leaseOwner: "runner_1",
  };
}

function fileChangeStartedEvent() {
  return {
    method: "item/started",
    params: {
      item: {
        id: "file_change_1",
        type: "fileChange",
        changes: [{ path: "src/index.ts", kind: "edit" }],
      },
    },
  };
}
