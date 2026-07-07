import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceRunAllowance } from "@/lib/billing/run-allowance";
import {
  buildGoatTaskContinuationPrompt,
  continueGoatTaskForActor,
  GOAT_TASK_CONTINUATION_MAX_CHARS,
} from "@/lib/goat-tasks/service";

vi.mock("@/lib/billing/run-allowance", () => ({
  ensureWorkspaceRunAllowance: vi.fn(),
  runAllowanceErrorMessage: vi.fn(() => "Add workspace credits to continue this session."),
}));

const ensureWorkspaceRunAllowanceMock = vi.mocked(ensureWorkspaceRunAllowance);

describe("continueGoatTaskForActor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureWorkspaceRunAllowanceMock.mockResolvedValue({
      allowed: true,
      allowance: {} as never,
    });
  });

  it("rejects empty or oversized input before touching the database", async () => {
    const db = createDb();

    await expect(baseContinue({ content: " ", db })).resolves.toEqual({
      ok: false,
      error: "Message is required.",
    });
    await expect(
      baseContinue({ content: "x".repeat(GOAT_TASK_CONTINUATION_MAX_CHARS + 1), db }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Message is too long"),
    });

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects no-balance workspaces before queueing work", async () => {
    ensureWorkspaceRunAllowanceMock.mockResolvedValue({
      allowed: false,
      reason: "no_balance",
      allowance: {} as never,
    });
    const db = createDb();

    await expect(baseContinue({ db })).resolves.toEqual({
      ok: false,
      error: "Add workspace credits to continue this session.",
    });

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("scopes the task lookup and rejects non-terminal tasks", async () => {
    const db = createDb(taskRow({ status: "running", stage: "running" }));

    await expect(baseContinue({ db })).resolves.toEqual({
      ok: false,
      error: "Only completed or failed tasks can be continued.",
    });

    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("inserts a continuation message, requeues the same task, and wakes the runner", async () => {
    const task = taskRow({ status: "succeeded", result: "Long prior result." });
    const messages = [
      messageRow({ id: "msg_user", role: "user", content: "Research Marseille." }),
      messageRow({
        id: "msg_assistant",
        role: "assistant",
        content: "Long prior result.",
        responseToMessageId: "msg_user",
      }),
    ];
    const events = [eventRow()];
    const db = createDb(task, messages, events);
    const wakeRunner = vi.fn(async () => undefined);

    const result = await baseContinue({
      db,
      wakeRunner,
      content: "Make it shorter.",
      now: new Date("2026-07-07T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      taskId: "goat_task_1",
      displayId: "TASK-1",
      messageId: expect.stringMatching(/^goat_task_msg_/),
    });
    expect(db.execute).toHaveBeenCalledTimes(5);
    expect(wakeRunner).toHaveBeenCalledWith("goat_task_1");
  });

  it("builds bounded continuation context from task outcome and recent transcript", () => {
    const prompt = buildGoatTaskContinuationPrompt({
      task: {
        displayId: "TASK-1",
        name: "Research",
        prompt: "Original prompt",
        status: "succeeded",
        result: "Result",
        error: null,
      },
      messages: [messageRow({ role: "user", content: "Original prompt" })],
      events: [eventRow()],
      latestInstruction: "Continue from here.",
    });

    expect(prompt).toContain("<original_prompt>Original prompt</original_prompt>");
    expect(prompt).toContain("<previous_result>Result</previous_result>");
    expect(prompt).toContain(
      "<latest_human_instruction>Continue from here.</latest_human_instruction>",
    );
    expect(prompt).toContain("Do not repeat completed work");
  });
});

function baseContinue(overrides: Partial<Parameters<typeof continueGoatTaskForActor>[0]> = {}) {
  return continueGoatTaskForActor({
    actor: "human",
    taskDisplayIdOrId: "TASK-1",
    content: "Follow up",
    authUserWorkosId: "workos_user_1",
    appUserId: "usr_1",
    workspaceId: "wks_1",
    ...overrides,
  });
}

function createDb(task = taskRow(), messages = [messageRow()], events = [eventRow()]) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([task])
    .mockResolvedValueOnce(messages)
    .mockResolvedValueOnce(events)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: task.id }]);
  const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => unknown) =>
    callback({ execute }),
  );
  return { execute, transaction } as never as {
    execute: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-07T10:00:00.000Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    userWorkosId: "workos_user_1",
    prompt: "Research Marseille.",
    model: "openai/gpt-5.4-mini",
    status: "succeeded",
    stage: "completed",
    result: "Done.",
    error: null,
    harnessSpec: {},
    debugTrace: {},
    codexEngineSessionId: "thread_1",
    sandboxId: null,
    attempts: 1,
    nextRunAt: now,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-07T10:00:00.000Z");
  return {
    id: "msg_1",
    role: "user",
    status: "completed",
    content: "Research Marseille.",
    modelMessage: { role: "user", content: "Research Marseille." },
    toolName: null,
    toolCallId: null,
    responseToMessageId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    messageId: "msg_1",
    type: "message.completed",
    payload: { role: "assistant" },
    createdAt: new Date("2026-07-07T10:00:00.000Z"),
    ...overrides,
  };
}
