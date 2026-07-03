import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { createGoatTaskForUser } from "@/lib/tasks";

const mocks = vi.hoisted(() => {
  return {
    execute: vi.fn(),
    triggerGoatTaskRun: vi.fn(),
  };
});

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
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
          model: DEFAULT_GOAT_MODEL,
          systemPrompt: "",
          initialUserMessage: "Research x",
          tools: ["exa_search", "gmail_search"],
          maxModelSteps: 8,
          resultMode: "assistant_final",
        },
        debugTrace: {},
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
