import { beforeEach, describe, expect, it, vi } from "vitest";
import { triggerGoatTaskRun } from "@/lib/task-runner";

const telemetry = vi.hoisted(() => ({
  startGoatSpan: vi.fn(() => ({
    setAttributes: vi.fn(),
    fail: vi.fn(() => "network"),
    end: vi.fn(),
  })),
  recordGoatTaskDispatch: vi.fn(),
}));

vi.mock("@opencompany/goat-observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/goat-observability")>();
  return {
    ...actual,
    startGoatSpan: telemetry.startGoatSpan,
    recordGoatTaskDispatch: telemetry.recordGoatTaskDispatch,
  };
});

describe("triggerGoatTaskRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("records a skipped dispatch when the runner is not configured", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "");
    vi.stubEnv("RUNNER_PUBLIC_URL", "");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "");

    await triggerGoatTaskRun("goat_task_1");

    expect(telemetry.recordGoatTaskDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        attributes: expect.objectContaining({
          "goat.task_id": "goat_task_1",
          "goat.failure_category": "runner_unconfigured",
        }),
      }),
    );
  });

  it("records accepted dispatches", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "https://runner.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 202 })),
    );

    await triggerGoatTaskRun("goat_task_1");

    expect(telemetry.recordGoatTaskDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        attributes: expect.objectContaining({
          "goat.task_id": "goat_task_1",
          "goat.dispatch_mode": "runner_wake",
        }),
      }),
    );
  });

  it("records failed dispatches", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "https://runner.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 503 })),
    );

    await expect(triggerGoatTaskRun("goat_task_1")).rejects.toThrow("503");

    expect(telemetry.recordGoatTaskDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        attributes: expect.objectContaining({
          "goat.task_id": "goat_task_1",
          "goat.failure_category": "network",
        }),
      }),
    );
  });
});
