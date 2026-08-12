import { describe, expect, it, vi } from "vitest";
import { type Actor, TASK_READ_PERMISSION, TASK_WRITE_PERMISSION } from "./actor";
import { CoreError } from "./chat";
import { type CreateTaskCommand, TaskApplicationService, type TaskRepository } from "./tasks";

describe("TaskApplicationService", () => {
  it("normalizes a Task command and passes only the authenticated Actor to persistence", async () => {
    const repository = fakeRepository();
    const service = new TaskApplicationService(repository);

    await expect(
      service.createTask(actor(), {
        idempotencyKey: " create-1 ",
        goal: "  Research the market.  ",
        engine: "opencompany",
        model: " provider/model ",
        source: "manual",
        attachmentIds: [" attachment_1 "],
      }),
    ).resolves.toMatchObject({ task: { id: "task_1" }, runId: "run_1" });

    expect(repository.createTaskAndRun).toHaveBeenCalledWith({
      actor: actor(),
      command: {
        idempotencyKey: "create-1",
        name: "Research the market",
        goal: "Research the market.",
        engine: "opencompany",
        model: "provider/model",
        source: "manual",
        attachmentIds: ["attachment_1"],
      },
    });
  });

  it("requires Task permissions and validates before persistence", () => {
    const repository = fakeRepository();
    const service = new TaskApplicationService(repository);

    expect(() =>
      service.createTask(actor({ permissions: [TASK_READ_PERMISSION] }), command()),
    ).toThrow(/not allowed/i);
    expect(() => service.createTask(actor(), command({ goal: " " }))).toThrow(/goal is required/i);
    expect(() =>
      service.createTask(actor(), command({ idempotencyKey: "contains a space" })),
    ).toThrow(/Idempotency-Key/i);
    expect(() => service.createTask(actor(), command({ attachmentIds: ["one", "one"] }))).toThrow(
      /unique/i,
    );
    expect(repository.createTaskAndRun).not.toHaveBeenCalled();
  });

  it("bounds reads and authorizes Task Conversation lookup", async () => {
    const repository = fakeRepository();
    const service = new TaskApplicationService(repository);

    await service.listTasks(actor(), { cursor: " page_1 ", limit: 999, archived: true });
    await service.getTaskByConversation(actor(), " conversation_1 ");

    expect(repository.listTasks).toHaveBeenCalledWith({
      actor: actor(),
      cursor: "page_1",
      limit: 100,
      archived: true,
    });
    expect(repository.getTaskByConversation).toHaveBeenCalledWith({
      actor: actor(),
      conversationId: "conversation_1",
    });
  });

  it("keeps archive mutation actor-scoped", async () => {
    const repository = fakeRepository();
    const service = new TaskApplicationService(repository);

    await expect(
      service.updateTask(actor(), " task_1 ", { archived: true }),
    ).resolves.toMatchObject({ task: { status: "archived" } });
    expect(repository.updateTask).toHaveBeenCalledWith({
      actor: actor(),
      taskId: "task_1",
      command: { archived: true },
    });
    await expect(
      service.updateTask(actor(), "task_1", { archived: undefined } as never),
    ).rejects.toThrow(/archive update is required/i);
    await expect(service.getTask(actor(), "missing")).rejects.toBeInstanceOf(CoreError);
  });

  it("normalizes Task names through the same actor-scoped mutation", async () => {
    const repository = fakeRepository();
    const service = new TaskApplicationService(repository);

    await service.updateTask(actor(), "task_1", { name: "  Launch brief  " });

    expect(repository.updateTask).toHaveBeenCalledWith({
      actor: actor(),
      taskId: "task_1",
      command: { name: "Launch brief" },
    });
    await expect(service.updateTask(actor(), "task_1", { name: " " })).rejects.toThrow(
      /name is invalid/i,
    );
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: [TASK_READ_PERMISSION, TASK_WRITE_PERMISSION],
    authenticationMethod: "session",
    ...overrides,
  };
}

function command(overrides: Partial<CreateTaskCommand> = {}): CreateTaskCommand {
  return {
    idempotencyKey: "create-1",
    goal: "Research the market.",
    engine: "opencompany",
    model: "provider/model",
    source: "manual",
    ...overrides,
  };
}

function fakeRepository(): TaskRepository & {
  createTaskAndRun: ReturnType<typeof vi.fn>;
  getTaskByConversation: ReturnType<typeof vi.fn>;
  getTaskSummary: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
} {
  const task = {
    id: "task_1",
    displayId: "TASK-1",
    name: "Research",
    goal: "Research the market.",
    conversationId: "conversation_1",
    status: "queued" as const,
    source: "manual" as const,
    engine: "opencompany" as const,
    model: "provider/model",
    workflowId: null,
    scheduleId: null,
    scheduledFor: null,
    outcome: { result: null, error: null, reportedStatus: null, comment: null },
    archivedAt: null,
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T00:00:00.000Z"),
  };
  return {
    listTasks: vi.fn(async () => ({ tasks: [task], nextCursor: null })),
    getTask: vi.fn(async ({ taskId }) => (taskId === task.id ? task : null)),
    getTaskSummary: vi.fn(async () => ({
      cost: { hasRecordedCosts: false, totalCostUsdMicros: 0 },
      durationMs: null,
    })),
    listLegacyTasks: vi.fn(async () => []),
    getLegacyTaskHistory: vi.fn(async () => null),
    getTaskByConversation: vi.fn(async () => task),
    createTaskAndRun: vi.fn(async () => ({
      task,
      messageId: "message_1",
      assistantMessageId: "message_2",
      runId: "run_1",
      transactionId: "42",
      idempotentReplay: false,
    })),
    updateTask: vi.fn(async () => ({
      task: { ...task, status: "archived" as const, archivedAt: task.updatedAt },
      transactionId: "43",
    })),
  };
}
