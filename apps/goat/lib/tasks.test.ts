import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { cancelGoatTaskAction, createGoatTaskForUser } from "@/lib/tasks";

const mocks = vi.hoisted(() => {
  return {
    execute: vi.fn(),
    select: vi.fn(),
    triggerGoatTaskRun: vi.fn(),
    triggerGoatCodexChatWake: vi.fn(),
    isGoatCodexConnectedForUser: vi.fn(),
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
  triggerGoatCodexChatWake: mocks.triggerGoatCodexChatWake,
}));

vi.mock("@/lib/codex-auth", () => ({
  isGoatCodexConnectedForUser: mocks.isGoatCodexConnectedForUser,
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
        scheduleId: null,
        scheduledFor: null,
        engine: "opencompany",
        status: "queued",
        result: null,
        error: null,
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

    expect(task).toMatchObject({ id: "task_1", status: "queued" });
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

  it("does not create or dispatch a task when background tasks are disabled", async () => {
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
    ).rejects.toThrow("Background tasks are disabled");

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
    ).rejects.toThrow("Background tasks are disabled");
    expect(mocks.triggerGoatTaskRun).not.toHaveBeenCalled();
  });

  it("rejects codex tasks when Codex is not connected", async () => {
    mocks.isGoatCodexConnectedForUser.mockResolvedValue(false);

    await expect(
      createGoatTaskForUser({
        userWorkosId: "user_1",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
        engine: "codex",
      }),
    ).rejects.toThrow("Connect Codex in Goat settings before starting a Codex task.");

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.triggerGoatTaskRun).not.toHaveBeenCalled();
    expect(mocks.triggerGoatCodexChatWake).not.toHaveBeenCalled();
  });

  it("creates a codex task with its run session, codex session, and queued turn", async () => {
    mocks.isGoatCodexConnectedForUser.mockResolvedValue(true);
    mocks.triggerGoatCodexChatWake.mockResolvedValue(undefined);

    const task = await createGoatTaskForUser({
      userWorkosId: "user_1",
      prompt: "Research x",
      model: DEFAULT_GOAT_MODEL,
      engine: "codex",
    });

    expect(task).toMatchObject({ id: "task_1", status: "queued" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const statement = sqlTextFromExecuteCall(0);
    expect(statement).toContain("task_spawning_enabled = true");
    expect(statement).toContain("'codex'");
    expect(statement).toContain("INSERT INTO goat.codex_chat_sessions");
    expect(statement).toContain("INSERT INTO goat.codex_chat_turns");
    expect(statement).toContain("EXISTS (SELECT 1 FROM inserted_turn)");
    expect(mocks.triggerGoatCodexChatWake).toHaveBeenCalledTimes(1);
    expect(mocks.triggerGoatTaskRun).not.toHaveBeenCalled();
  });

  it("leaves a codex task queued for polling when the codex chat wake fails", async () => {
    mocks.isGoatCodexConnectedForUser.mockResolvedValue(true);
    mocks.triggerGoatCodexChatWake.mockRejectedValue(new Error("runner unavailable"));

    const task = await createGoatTaskForUser({
      userWorkosId: "user_1",
      prompt: "Research x",
      model: DEFAULT_GOAT_MODEL,
      engine: "codex",
    });

    expect(task).toMatchObject({ id: "task_1", status: "queued" });
    expect(warnSpy).toHaveBeenCalledWith(
      "Goat codex chat wake failed; the task turn waits for polling.",
      expect.objectContaining({ event: "goat.codex_chat_wake_failed" }),
    );
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
    expect(sqlTextFromExecuteCall(0)).toContain("UPDATE goat.tasks AS task");
    expect(sqlTextFromExecuteCall(0)).toContain("INSERT INTO goat.task_comments");
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
