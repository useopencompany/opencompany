import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  goatRunnerConfigured,
  triggerGoatCodexChatWake,
  triggerGoatTaskRun,
} from "@/lib/task-runner";

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

  it("reports runner configuration when the public URL fallback is available", () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "");
    vi.stubEnv("RUNNER_PUBLIC_URL", "https://runner-public.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");

    expect(goatRunnerConfigured()).toBe(true);
  });

  it("reports missing runner configuration when URL and token are empty", () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "");
    vi.stubEnv("RUNNER_PUBLIC_URL", "");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "");

    expect(goatRunnerConfigured()).toBe(false);
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

describe("triggerGoatCodexChatWake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sends authenticated wake requests", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "https://runner.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await triggerGoatCodexChatWake();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://runner.example.com/internal/goat/codex-chat/wake",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("aborts wake requests that do not return promptly", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RUNNER_INTERNAL_URL", "https://runner.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }),
    );

    const wake = expect(triggerGoatCodexChatWake()).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5_000);

    await wake;
  });
});
