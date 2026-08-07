import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCodexSandboxStatus,
  requestCodingWorkspaceRuntimeAccess,
  requestDictationAccess,
  runnerConfigured,
  triggerCodexChatWake,
} from "@/lib/task-runner";

describe("triggerCodexChatWake", () => {
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

    await triggerCodexChatWake();

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

    const wake = expect(triggerCodexChatWake()).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5_000);

    await wake;
  });
});

describe("getCodexSandboxStatus", () => {
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

    await expect(getCodexSandboxStatus("sbx_123")).resolves.toBe("sleeping");

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

describe("requestCodingWorkspaceRuntimeAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the same-origin dev proxy when Goat is HTTPS and the runner is local HTTP", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://127.0.0.1:3040");
    vi.stubEnv("RUNNER_PUBLIC_URL", "http://localhost:3040");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://localhost:3443");
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
      requestCodingWorkspaceRuntimeAccess({
        codingSessionId: "goat_codex_chat_1",
        userWorkosId: "user_1",
      }),
    ).resolves.toMatchObject({
      websocketUrl: "wss://localhost:3443/goat/runtime",
      ticket: "ticket_1",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3040/internal/goat/coding-workspaces/sessions/goat_codex_chat_1/runtime-access",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the hosted runner URL in production-style environments", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "https://runner-internal.example.com");
    vi.stubEnv("RUNNER_PUBLIC_URL", "https://runner.example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://goat.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ticket: "ticket_1", expiresAt: 60_000, sandboxStatus: "running" }),
      ),
    );

    await expect(
      requestCodingWorkspaceRuntimeAccess({
        codingSessionId: "goat_codex_chat_1",
        userWorkosId: "user_1",
      }),
    ).resolves.toMatchObject({ websocketUrl: "wss://runner.example.com/goat/runtime" });
  });
});

describe("requestDictationAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the same-origin dev proxy when Goat is HTTPS and the runner is local HTTP", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://127.0.0.1:3040");
    vi.stubEnv("RUNNER_PUBLIC_URL", "http://localhost:3040");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://localhost:3443");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ticket: "ticket_1", expiresAt: 60_000 })),
    );

    await expect(requestDictationAccess({ userWorkosId: "user_1" })).resolves.toEqual({
      websocketUrl: "wss://localhost:3443/goat/dictation",
      ticket: "ticket_1",
      expiresAt: 60_000,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3040/internal/goat/dictation/access",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the hosted runner URL in production-style environments", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "https://runner-internal.example.com");
    vi.stubEnv("RUNNER_PUBLIC_URL", "https://runner.example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://goat.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ticket: "ticket_1", expiresAt: 60_000 })),
    );

    await expect(requestDictationAccess({ userWorkosId: "user_1" })).resolves.toMatchObject({
      websocketUrl: "wss://runner.example.com/goat/dictation",
    });
  });
});
