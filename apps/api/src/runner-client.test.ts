import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunnerClient } from "./runner-client";

describe("runner client", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts JSON with the internal bearer token against the internal URL", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, flow: { id: "flow_1" } }));
    const client = createRunnerClient({
      url: "https://runner.internal/",
      token: "runner-secret",
      fetch: fetchMock as never,
    });

    await expect(
      client.postJson(
        "/internal/goat/codex-auth/device/start",
        { userWorkosId: "user_1" },
        {
          errorFormat: "status-text",
        },
      ),
    ).resolves.toEqual({ ok: true, flow: { id: "flow_1" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://runner.internal/internal/goat/codex-auth/device/start",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer runner-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userWorkosId: "user_1" }),
      },
    );
  });

  it("supports authenticated JSON reads without sending a request body", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, status: "sleeping" }));
    const client = createRunnerClient({
      url: "https://runner.internal/",
      token: "runner-secret",
      fetch: fetchMock as never,
    });

    await expect(
      client.requestJson("/internal/goat/codex-chat/sandboxes/sandbox_1/status", {
        method: "GET",
        errorFormat: "error-message",
      }),
    ).resolves.toEqual({ ok: true, status: "sleeping" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://runner.internal/internal/goat/codex-chat/sandboxes/sandbox_1/status",
      {
        method: "GET",
        headers: { Authorization: "Bearer runner-secret" },
      },
    );
  });

  it("falls back from RUNNER_INTERNAL_URL to RUNNER_PUBLIC_URL like the retired web helpers", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "");
    vi.stubEnv("RUNNER_PUBLIC_URL", "https://runner.public");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "env-secret");
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    const client = createRunnerClient({ fetch: fetchMock as never });

    await client.postJson(
      "/internal/goat/infisical-auth/start",
      {},
      {
        errorFormat: "error-message",
      },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://runner.public/internal/goat/infisical-auth/start",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer env-secret" }),
      }),
    );
  });

  it("reports a missing runner configuration with the retired copy", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "");
    vi.stubEnv("RUNNER_PUBLIC_URL", "");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "");
    const client = createRunnerClient({ fetch: vi.fn() as never });
    await expect(
      client.postJson(
        "/internal/goat/codex-auth/device/start",
        {},
        {
          errorFormat: "status-text",
        },
      ),
    ).rejects.toThrow("Runner is not configured.");
  });

  it("preserves the raw status-text error format used by the Codex flow", async () => {
    const fetchMock = vi.fn(async () => new Response("device flow not available", { status: 502 }));
    const client = createRunnerClient({
      url: "https://runner.internal",
      token: "runner-secret",
      fetch: fetchMock as never,
    });
    await expect(
      client.postJson(
        "/internal/goat/codex-auth/device/start",
        {},
        {
          errorFormat: "status-text",
        },
      ),
    ).rejects.toThrow("Runner request failed with 502: device flow not available");
  });

  it("preserves the JSON error-message format used by the Infisical flow", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "Only workspace admins can do this." }, { status: 403 }),
    );
    const client = createRunnerClient({
      url: "https://runner.internal",
      token: "runner-secret",
      fetch: fetchMock as never,
    });
    await expect(
      client.postJson(
        "/internal/goat/infisical-auth/start",
        {},
        {
          errorFormat: "error-message",
        },
      ),
    ).rejects.toThrow("Only workspace admins can do this.");

    const nonJson = createRunnerClient({
      url: "https://runner.internal",
      token: "runner-secret",
      fetch: vi.fn(async () => new Response("boom", { status: 500 })) as never,
    });
    await expect(
      nonJson.postJson(
        "/internal/goat/infisical-auth/start",
        {},
        {
          errorFormat: "error-message",
        },
      ),
    ).rejects.toThrow("Runner request failed.");
  });
});
