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
    execute: vi.fn(),
    select: vi.fn(),
    triggerGoatTaskRun: vi.fn(),
  };
});

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
    select: mocks.select,
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

beforeEach(() => {
  vi.mocked(currentGoatUser).mockResolvedValue({
    user: { workosUserId: "user_1" },
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
        taskSpawningEnabled: true,
        localCodexBetaEnabled: false,
        chatCapabilitiesBetaEnabled: false,
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

describe("continueGoatTaskAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(sqlTextFromExecuteCall(0)).toContain("INSERT INTO goat.task_messages");
    expect(mocks.triggerGoatTaskRun).toHaveBeenCalledWith("goat_task_1", {
      task_id: "goat_task_1",
      event: "goat.runner_task_continued_dispatch",
    });
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
  const query = mocks.execute.mock.calls[callIndex]?.[0] as
    | { queryChunks?: Array<string | { value?: string[] }> }
    | undefined;
  return (
    query?.queryChunks
      ?.map((chunk) =>
        typeof chunk === "string" ? "?" : ((chunk?.value ?? []) as string[]).join(""),
      )
      .join("") ?? ""
  );
}
