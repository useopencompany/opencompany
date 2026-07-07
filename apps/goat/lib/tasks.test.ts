import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import {
  buildGoatTaskContinuationPrompt,
  GOAT_TASK_CONTINUATION_MAX_CHARS,
  type GoatTaskContinuationEventRow,
  type GoatTaskContinuationMessageRow,
} from "@/lib/task-continuation";
import {
  cancelGoatTaskAction,
  continueGoatTaskAction,
  continueGoatTaskForActor,
  createGoatTaskForUser,
} from "@/lib/tasks";

const mocks = vi.hoisted(() => {
  return {
    execute: vi.fn(),
    triggerGoatTaskRun: vi.fn(),
  };
});

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
    transaction: async (callback: (tx: { execute: typeof mocks.execute }) => unknown) =>
      callback({ execute: mocks.execute }),
  }),
}));

vi.mock("@/lib/task-runner", () => ({
  triggerGoatTaskRun: mocks.triggerGoatTaskRun,
}));

vi.mock("@/lib/integrations/google-data", () => ({
  getGoatAvailableHarnessTools: vi.fn(async () => ["exa_search", "gmail_search"]),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

describe("createGoatTaskForUser", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue([
      {
        id: "task_1",
        displayId: "TASK-1",
        userWorkosId: "user_1",
        name: "Research x",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
        status: "queued",
        stage: "queued",
        result: null,
        error: null,
        harnessSpec: {
          schemaVersion: "goat.harness.v1",
          engine: "opencompany",
          model: DEFAULT_GOAT_MODEL,
          systemPrompt: "",
          initialUserMessage: "Research x",
          tools: ["exa_search", "gmail_search"],
          skills: [],
          maxModelSteps: 16,
          resultMode: "assistant_final",
        },
        debugTrace: {},
        codexEngineSessionId: null,
        sandboxId: null,
        attempts: 0,
        nextRunAt: "2026-01-01T00:00:00.000Z",
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("leaves the task queued when runner dispatch fails", async () => {
    mocks.triggerGoatTaskRun.mockRejectedValue(new Error("runner unavailable"));

    const task = await createGoatTaskForUser({
      userWorkosId: "user_1",
      prompt: "Research x",
      model: DEFAULT_GOAT_MODEL,
    });

    expect(task).toMatchObject({ id: "task_1", status: "queued", stage: "queued" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.triggerGoatTaskRun).toHaveBeenCalledWith(
      expect.stringMatching(/^goat_task_/),
      expect.objectContaining({ event: "goat.runner_task_created_dispatch" }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Goat runner dispatch failed; the task remains queued for polling.",
      expect.objectContaining({
        event: "goat.runner_task_created_dispatch_failed",
      }),
    );
  });
});

describe("cancelGoatTaskAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser).mockResolvedValue({
      authUser: {
        id: "user_1",
        email: "ada@example.com",
      } as never,
      user: {
        workosUserId: "user_1",
        email: "ada@example.com",
        firstName: null,
        lastName: null,
        avatarUrl: null,
        timezone: "UTC",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
  });

  it("cancels an active task for the current user", async () => {
    mocks.execute.mockResolvedValueOnce([{ id: "goat_task_1" }]);

    await expect(cancelGoatTaskAction("goat_task_1")).resolves.toEqual({
      ok: true,
      error: null,
    });

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(sqlTextFromExecuteCall(0)).toContain("UPDATE goat.task_messages AS message");
    expect(sqlTextFromExecuteCall(0)).toContain("message.status = 'running'");
    expect(sqlTextFromExecuteCall(0)).toContain("'Stopped by user.'");
  });

  it("rejects terminal or inaccessible tasks", async () => {
    mocks.execute.mockResolvedValueOnce([]);

    await expect(cancelGoatTaskAction("goat_task_done")).resolves.toEqual({
      ok: false,
      error: "Could not stop task.",
    });
  });
});

describe("continueGoatTaskForActor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects empty or oversized input before touching the database", async () => {
    const db = createContinuationDb();

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

    expect(db.execute).not.toHaveBeenCalled();
  });

  it("scopes the task lookup and rejects non-terminal tasks", async () => {
    const db = createContinuationDb(continuationTaskRow({ status: "running", stage: "running" }));

    await expect(baseContinue({ db })).resolves.toEqual({
      ok: false,
      error: "Only completed or failed tasks can be continued.",
    });

    expect(db.execute).toHaveBeenCalledOnce();
    expect(sqlTextFromContinuationExecuteCall(db, 0)).toContain("AND task.user_workos_id =");
    expect(sqlTextFromContinuationExecuteCall(db, 0)).toContain("AND task.archived_at IS NULL");
  });

  it("rejects terminal tasks that still have an active lease", async () => {
    const db = createContinuationDb(continuationTaskRow({ status: "failed", leaseId: "lease_1" }));

    await expect(baseContinue({ db })).resolves.toEqual({
      ok: false,
      error: "This task is still running. Try again shortly.",
    });
  });

  it("inserts a continuation message, requeues the same task, and wakes the runner", async () => {
    const task = continuationTaskRow({ status: "succeeded", result: "Long prior result." });
    const messages = [
      continuationMessageRow({ id: "msg_user", role: "user", content: "Research Marseille." }),
      continuationMessageRow({
        id: "msg_assistant",
        role: "assistant",
        content: "Long prior result.",
        responseToMessageId: "msg_user",
      }),
    ];
    const events = [continuationEventRow()];
    const db = createContinuationDb(task, messages, events);
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
    expect(db.execute).toHaveBeenCalledTimes(4);
    expect(sqlTextFromContinuationExecuteCall(db, 3)).toContain("INSERT INTO goat.task_messages");
    expect(sqlTextFromContinuationExecuteCall(db, 3)).toContain("UPDATE goat.tasks");
    expect(sqlTextFromContinuationExecuteCall(db, 3)).toContain("result = NULL");
    expect(sqlTextFromContinuationExecuteCall(db, 3)).toContain("INSERT INTO goat.task_events");
    expect(wakeRunner).toHaveBeenCalledWith("goat_task_1");
  });

  it("keeps the task queued when runner wake fails", async () => {
    const db = createContinuationDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      baseContinue({
        db,
        wakeRunner: vi.fn(async () => {
          throw new Error("runner unavailable");
        }),
      }),
    ).resolves.toMatchObject({ ok: true, taskId: "goat_task_1" });

    expect(warnSpy).toHaveBeenCalledWith(
      "Goat runner dispatch failed; the continued task remains queued for polling.",
      expect.objectContaining({
        event: "goat.runner_task_continued_dispatch_failed",
        task_id: "goat_task_1",
      }),
    );
    warnSpy.mockRestore();
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
      messages: [continuationMessageRow({ role: "user", content: "Original prompt" })],
      events: [continuationEventRow()],
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

describe("continueGoatTaskAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser).mockResolvedValue({
      authUser: {
        id: "user_1",
        email: "ada@example.com",
      } as never,
      user: {
        workosUserId: "user_1",
        email: "ada@example.com",
        firstName: null,
        lastName: null,
        avatarUrl: null,
        timezone: "UTC",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    mocks.execute
      .mockResolvedValueOnce([continuationTaskRow()])
      .mockResolvedValueOnce([continuationMessageRow()])
      .mockResolvedValueOnce([continuationEventRow()])
      .mockResolvedValueOnce([
        { taskId: "goat_task_1", displayId: "TASK-1", messageId: "goat_task_msg_1" },
      ]);
    mocks.triggerGoatTaskRun.mockResolvedValue(undefined);
  });

  it("uses the current Goat user and wakes the Goat runner", async () => {
    const result = await continueGoatTaskAction("TASK-1", "Follow up");

    expect(result).toMatchObject({ ok: true, taskId: "goat_task_1" });
    expect(mocks.triggerGoatTaskRun).toHaveBeenCalledWith(
      "goat_task_1",
      expect.objectContaining({ event: "goat.runner_task_continued_dispatch" }),
    );
  });
});

function sqlTextFromExecuteCall(callIndex: number) {
  const query = mocks.execute.mock.calls[callIndex]?.[0] as
    | { queryChunks?: Array<string | { value?: string[] }> }
    | undefined;
  return (
    query?.queryChunks
      ?.map((chunk) => (typeof chunk === "string" ? "?" : (chunk.value ?? []).join("")))
      .join("") ?? ""
  );
}

function baseContinue(overrides: Partial<Parameters<typeof continueGoatTaskForActor>[0]> = {}) {
  return continueGoatTaskForActor({
    actor: "human",
    taskDisplayIdOrId: "TASK-1",
    content: "Follow up",
    userWorkosId: "workos_user_1",
    ...overrides,
  });
}

function createContinuationDb(
  task = continuationTaskRow(),
  messages = [continuationMessageRow()],
  events = [continuationEventRow()],
): ContinuationTestDb {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([task])
    .mockResolvedValueOnce(messages)
    .mockResolvedValueOnce(events)
    .mockResolvedValueOnce([
      { taskId: task.id, displayId: task.displayId, messageId: "goat_task_msg_1" },
    ]);
  const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => unknown) =>
    callback({ execute }),
  );
  return { execute, transaction } as ContinuationTestDb;
}

function sqlTextFromContinuationExecuteCall(
  db: { execute: ReturnType<typeof vi.fn> },
  callIndex: number,
) {
  const query = db.execute.mock.calls[callIndex]?.[0] as
    | { queryChunks?: Array<string | { value?: string[] }> }
    | undefined;
  return (
    query?.queryChunks
      ?.map((chunk) => (typeof chunk === "string" ? "?" : (chunk.value ?? []).join("")))
      .join("") ?? ""
  );
}

function continuationTaskRow(overrides: Record<string, unknown> = {}) {
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

type ContinuationTestDb = NonNullable<Parameters<typeof continueGoatTaskForActor>[0]["db"]> & {
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

function continuationMessageRow(
  overrides: Partial<GoatTaskContinuationMessageRow> = {},
): GoatTaskContinuationMessageRow {
  const now = new Date("2026-07-07T10:00:00.000Z");
  return {
    id: "msg_1",
    role: "user" as const,
    status: "completed" as const,
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

function continuationEventRow(
  overrides: Partial<GoatTaskContinuationEventRow> = {},
): GoatTaskContinuationEventRow {
  return {
    id: 1,
    messageId: "msg_1",
    type: "message.completed" as const,
    payload: { role: "assistant" },
    createdAt: new Date("2026-07-07T10:00:00.000Z"),
    ...overrides,
  };
}
