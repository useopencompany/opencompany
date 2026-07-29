import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoatCodexRuntimeAccess,
  getGoatCodexSandboxStatus,
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

describe("getGoatCodexSandboxStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fetches sandbox status from the runner", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "https://runner.example.com/");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, status: "sleeping" }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGoatCodexSandboxStatus("sbx_123")).resolves.toBe("sleeping");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://runner.example.com/internal/goat/codex-chat/sandboxes/sbx_123/status",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe("createGoatCodexRuntimeAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the same-origin dev proxy when Goat is HTTPS and the runner is local HTTP", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://127.0.0.1:3040");
    vi.stubEnv("RUNNER_PUBLIC_URL", "http://localhost:3040");
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://localhost:3443");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ticket: "ticket_1",
          expiresAt: 60_000,
          sandboxStatus: "sleeping",
        }),
      ),
    );

    await expect(
      createGoatCodexRuntimeAccess({
        codexChatSessionId: "goat_codex_chat_1",
        userWorkosId: "user_1",
      }),
    ).resolves.toMatchObject({
      websocketUrl: "wss://localhost:3443/goat/runtime",
      ticket: "ticket_1",
    });
  });

  it("uses the hosted runner URL in production-style environments", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "https://runner-internal.example.com");
    vi.stubEnv("RUNNER_PUBLIC_URL", "https://runner.example.com");
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://goat.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ticket: "ticket_1", expiresAt: 60_000, sandboxStatus: "running" }),
      ),
    );

    await expect(
      createGoatCodexRuntimeAccess({
        codexChatSessionId: "goat_codex_chat_1",
        userWorkosId: "user_1",
      }),
    ).resolves.toMatchObject({ websocketUrl: "wss://runner.example.com/goat/runtime" });
  });
});
