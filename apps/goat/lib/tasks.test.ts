import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { createGoatTaskForUser } from "@/lib/tasks";

const mocks = vi.hoisted(() => {
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return {
    returning,
    values,
    insert,
    triggerGoatTaskRun: vi.fn(),
  };
});

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    insert: mocks.insert,
  }),
}));

vi.mock("@/lib/task-runner", () => ({
  triggerGoatTaskRun: mocks.triggerGoatTaskRun,
}));

vi.mock("@/lib/integrations/google-data", () => ({
  getGoatAvailableHarnessTools: vi.fn(async () => ["exa", "goat_result"]),
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
    mocks.values.mockReturnValue({ returning: mocks.returning });
    mocks.insert.mockReturnValue({ values: mocks.values });
    mocks.returning.mockResolvedValue([
      {
        id: "task_1",
        userWorkosId: "user_1",
        name: "Research x",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
        status: "queued",
        stage: "queued",
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
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
        status: "queued",
        stage: "queued",
        harnessSpec: {
          prompt: "Research x",
          model: DEFAULT_GOAT_MODEL,
          tools: ["exa", "goat_result"],
          resultMode: "freeform",
        },
      }),
    );
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
