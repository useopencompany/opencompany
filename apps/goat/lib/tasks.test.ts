import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import {
  cancelGoatTaskAction,
  continueGoatTaskAction,
  createGoatTaskForUser,
  getCurrentUserGoatTaskSummary,
} from "@/lib/tasks";

const mocks = vi.hoisted(() => {
  return {
    after: vi.fn((work: Promise<unknown> | (() => unknown)) =>
      typeof work === "function" ? work() : work,
    ),
    captureGoatTaskSpawned: vi.fn(async () => undefined),
    execute: vi.fn(),
    select: vi.fn(),
    triggerGoatCodexChatWake: vi.fn(),
    triggerGoatTaskRun: vi.fn(),
  };
});

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatTaskSpawned: mocks.captureGoatTaskSpawned,
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
    select: mocks.select,
  }),
}));

vi.mock("@/lib/task-runner", () => ({
  triggerGoatCodexChatWake: mocks.triggerGoatCodexChatWake,
  triggerGoatTaskRun: mocks.triggerGoatTaskRun,
}));

vi.mock("@/lib/integrations/google-data", () => ({
  getGoatAvailableHarnessTools: vi.fn(async () => ["exa_search", "gmail_search"]),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("next/server", () => ({
  after: mocks.after,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(currentGoatUser).mockResolvedValue({
    user: { workosUserId: "user_1" },
    workspace: { id: "workspace_1" },
  } as never);
});

describe("createGoatTaskForUser", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ enabled: true }]),
        })),
      })),
    });
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
    mocks.triggerGoatCodexChatWake.mockRejectedValue(new Error("runner unavailable"));

    const task = await createGoatTaskForUser({
      userWorkosId: "user_1",
      prompt: "Research x",
      model: DEFAULT_GOAT_MODEL,
    });

    expect(task).toMatchObject({ id: "task_1", status: "queued", stage: "queued" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.captureGoatTaskSpawned).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        workspaceId: null,
        taskId: "task_1",
        displayId: "TASK-1",
        engine: "opencompany",
        model: DEFAULT_GOAT_MODEL,
        workflowId: undefined,
        scheduleId: undefined,
        trigger: "manual",
      }),
    );
    expect(mocks.triggerGoatCodexChatWake).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      "Goat durable task wake failed; the turn remains queued for polling.",
      expect.objectContaining({
        event: "goat.durable_task_created_wake_failed",
      }),
    );
    expect(sqlTextFromExecuteCall(0)).toContain("task_spawning_enabled = true");
  });

  it("does not create or dispatch a task when Tasks & Workflows is disabled", async () => {
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ enabled: false }]),
        })),
      })),
    });

    await expect(
      createGoatTaskForUser({
        userWorkosId: "user_1",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
      }),
    ).rejects.toThrow("Tasks & Workflows is disabled");

    expect(mocks.triggerGoatTaskRun).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.captureGoatTaskSpawned).not.toHaveBeenCalled();
  });

  it("reports a concurrent disable when the atomic insert is rejected", async () => {
    mocks.select
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ enabled: true }]) })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ enabled: false }]) })),
        })),
      });
    mocks.execute.mockResolvedValueOnce([]);

    await expect(
      createGoatTaskForUser({
        userWorkosId: "user_1",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
      }),
    ).rejects.toThrow("Tasks & Workflows is disabled");
    expect(mocks.triggerGoatTaskRun).not.toHaveBeenCalled();
    expect(mocks.captureGoatTaskSpawned).not.toHaveBeenCalled();
  });

  it("reports an unknown user separately from a disabled preference", async () => {
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    });

    await expect(
      createGoatTaskForUser({
        userWorkosId: "missing_user",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
      }),
    ).rejects.toThrow("unknown user");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.captureGoatTaskSpawned).not.toHaveBeenCalled();
  });
});

describe("getCurrentUserGoatTaskSummary", () => {
  it("returns aggregate cost and active run duration without loading the full transcript", async () => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              id: "task_1",
              displayId: "TASK-1",
              userWorkosId: "user_1",
              status: "succeeded",
            },
          ]),
        })),
      })),
    });
    mocks.execute.mockResolvedValue([
      {
        runStartedAt: "2026-01-01T00:00:10.000Z",
        runCompletedAt: "2026-01-01T00:03:22.000Z",
        usageRowCount: "3",
        totalCostUsdMicros: "123400",
      },
    ]);

    await expect(getCurrentUserGoatTaskSummary("TASK-1")).resolves.toEqual({
      cost: {
        hasRecordedCosts: true,
        totalCostUsdMicros: 123_400,
      },
      durationMs: 192_000,
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(sqlTextFromExecuteCall(0)).toContain("SELECT MIN");
    expect(sqlTextFromExecuteCall(0)).toContain("SELECT COUNT(*)");
  });

  it("summarizes session task duration and linked chat credit debits across workflow step sessions", async () => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              id: "task_1",
              displayId: "TASK-1",
              userWorkosId: "user_1",
              sessionId: "goat_chat_task_1",
              status: "succeeded",
            },
          ]),
        })),
      })),
    });
    mocks.execute.mockResolvedValue([
      {
        runStartedAt: null,
        runCompletedAt: null,
        runDurationMs: "245000",
        usageRowCount: "2",
        totalCostUsdMicros: "81400",
      },
    ]);

    await expect(getCurrentUserGoatTaskSummary("TASK-1")).resolves.toEqual({
      cost: {
        hasRecordedCosts: true,
        totalCostUsdMicros: 81_400,
      },
      durationMs: 245_000,
    });
    expect(sqlTextFromExecuteCall(0)).toContain("goat.credit_ledger");
    expect(sqlTextFromExecuteCall(0)).toContain("goat.chat_messages");
    expect(sqlTextFromExecuteCall(0)).toContain("WITH task_chat_sessions AS");
    expect(sqlTextFromExecuteCall(0)).toContain("SELECT DISTINCT message.session_id");
    expect(sqlTextFromExecuteCall(0)).toContain("message.task_id =");
    expect(sqlTextFromExecuteCall(0)).toContain("IN (SELECT session_id FROM task_chat_sessions)");
    expect(sqlTextFromExecuteCall(0)).not.toContain("goat.task_model_usage");
  });
});

describe("cancelGoatTaskAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ sessionId: "goat_chat_task_1", userWorkosId: "user_1" }]),
        })),
      })),
    });
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
        taskSpawningEnabled: true,
        autoModelRoutingEnabled: false,
        chatCapabilitiesBetaEnabled: false,
        imessageEnabled: false,
        taskViewMode: "board",
        preferredMcpClient: null,
        mcpSetupCompletedAt: null,
        onboardedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      workspace: {
        id: "goat_ws_user_1",
        workosOrganizationId: null,
        name: "Ada's Workspace",
        slug: null,
        createdByWorkosId: "user_1",
        capabilitySessionBudgetUsdMicros: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      role: "admin",
      workspaces: [
        {
          workspace: {
            id: "goat_ws_user_1",
            workosOrganizationId: null,
            name: "Ada's Workspace",
            slug: null,
            createdByWorkosId: "user_1",
            capabilitySessionBudgetUsdMicros: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          role: "admin",
        },
      ],
      brains: [],
      activeBrain: null,
    });
  });

  it("cancels an active task for the current user", async () => {
    mocks.execute.mockResolvedValueOnce([{ id: "goat_task_1" }]);

    await expect(cancelGoatTaskAction("goat_task_1")).resolves.toEqual({
      ok: true,
      error: null,
    });

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(sqlTextFromExecuteCall(0)).toContain("UPDATE goat.codex_chat_turns AS turn");
    expect(sqlTextFromExecuteCall(0)).toContain("UPDATE goat.chat_messages AS message");
    expect(sqlTextFromExecuteCall(0)).toContain("turn.status = 'running'");
    expect(sqlTextFromExecuteCall(0)).toContain("'Stopped by user.'");
    expect(sqlTextFromExecuteCall(0)).not.toContain("goat.task_messages");
  });

  it("rejects terminal or inaccessible tasks", async () => {
    mocks.execute.mockResolvedValueOnce([]);

    await expect(cancelGoatTaskAction("goat_task_done")).resolves.toEqual({
      ok: false,
      error: "Could not stop task.",
    });
  });
});

describe("continueGoatTaskAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ sessionId: "goat_chat_task_1", userWorkosId: "user_1" }]),
        })),
      })),
    });
  });

  it("appends a user turn and requeues a completed task", async () => {
    const messageId = "goat_task_msg_11111111-1111-4111-8111-111111111111";
    mocks.execute.mockResolvedValueOnce([{ id: messageId, task_id: "goat_task_1" }]);

    await expect(
      continueGoatTaskAction("goat_task_1", "Check the afternoon too.", messageId),
    ).resolves.toEqual({
      ok: true,
      error: null,
      messageId,
    });

    expect(sqlTextFromExecuteCall(0)).toContain(
      "task.status IN ('succeeded', 'failed', 'canceled')",
    );
    expect(sqlTextFromExecuteCall(0)).toContain("INSERT INTO goat.chat_messages");
    expect(sqlTextFromExecuteCall(0)).toContain("INSERT INTO goat.codex_chat_turns");
    expect(sqlTextFromExecuteCall(0)).not.toContain("goat.task_messages");
    expect(mocks.triggerGoatCodexChatWake).toHaveBeenCalledOnce();
    expect(mocks.triggerGoatTaskRun).not.toHaveBeenCalled();
  });

  it("continues a session-backed task owned by another workspace member", async () => {
    vi.mocked(currentGoatUser).mockResolvedValue({
      user: { workosUserId: "member_2" },
      workspace: { id: "workspace_1" },
    } as never);
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ sessionId: "goat_chat_task_1", userWorkosId: "owner_1" }]),
        })),
      })),
    });
    mocks.execute.mockResolvedValueOnce([{ id: "goat_chat_msg_1", task_id: "goat_task_1" }]);

    await expect(
      continueGoatTaskAction("goat_task_1", "Check the afternoon too."),
    ).resolves.toEqual({
      ok: true,
      error: null,
      messageId: "goat_chat_msg_1",
    });

    const query = renderedExecuteCall(0);
    expect(query.params).toContain("owner_1");
    expect(query.params).not.toContain("member_2");
  });

  it("does not append another turn while the task is active or inaccessible", async () => {
    mocks.execute.mockResolvedValueOnce([]);

    await expect(continueGoatTaskAction("goat_task_1", "Check again.")).resolves.toMatchObject({
      ok: false,
      messageId: null,
    });

    expect(mocks.triggerGoatTaskRun).not.toHaveBeenCalled();
  });

  it("rejects an empty reply before touching the database", async () => {
    await expect(continueGoatTaskAction("goat_task_1", "   ")).resolves.toMatchObject({
      ok: false,
      messageId: null,
    });

    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

function sqlTextFromExecuteCall(callIndex: number) {
  return renderedExecuteCall(callIndex).sql;
}

function renderedExecuteCall(callIndex: number) {
  const query = mocks.execute.mock.calls[callIndex]?.[0] as SQL | undefined;
  expect(query).toBeDefined();
  return new PgDialect().sqlToQuery(query!);
}
