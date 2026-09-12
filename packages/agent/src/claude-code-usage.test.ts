import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ loadClaudeCodeCredential: vi.fn() }));
vi.mock("@opencompany/db/claude-code-auth", () => db);

import { fetchClaudeCodeUsage } from "./claude-code-usage";

// The credential loader is mocked, so the handle is only here to satisfy the signature.
const dbStub = {} as Parameters<typeof fetchClaudeCodeUsage>[0]["db"];

const credential = { status: "connected", authJson: { token: "sk-ant-oat01-secret" } };
const reset = 2_000_000_000;
const headers = {
  "anthropic-ratelimit-unified-5h-utilization": "0.2",
  "anthropic-ratelimit-unified-5h-reset": String(reset),
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.635",
  "anthropic-ratelimit-unified-7d-reset": String(reset + 86_400),
};

describe("Claude Code subscription usage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.loadClaudeCodeCredential.mockResolvedValue(credential);
  });

  it("reads the unified windows from a minimal inference probe", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200, headers }));
    const result = await fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-ant-oat01-secret",
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
        }),
        redirect: "error",
        cache: "no-store",
      }),
    );
    expect(db.loadClaudeCodeCredential).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_1" }),
    );
    expect(result).toEqual({
      updatedAt: expect.any(String),
      windows: [
        {
          id: "claude-code:5h",
          label: "Session",
          usedPercent: 20,
          resetsAt: new Date(reset * 1_000).toISOString(),
        },
        {
          id: "claude-code:7d",
          label: "Weekly",
          usedPercent: 63.5,
          resetsAt: new Date((reset + 86_400) * 1_000).toISOString(),
        },
      ],
    });
  });

  it("keeps known windows first and labels model-scoped limits it has not seen", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: {
            "anthropic-ratelimit-unified-7d_haiku-utilization": "0.5",
            "anthropic-ratelimit-unified-7d_haiku-reset": String(reset),
            ...headers,
          },
        }),
    );
    const result = await fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl });
    expect(result.windows.map((window) => window.label)).toEqual(["Session", "Weekly", "7d haiku"]);
  });

  it("reports a rate-limited account instead of failing the card", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { ...headers, "anthropic-ratelimit-unified-5h-utilization": "1" },
        }),
    );
    const result = await fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl });
    expect(result.windows[0]).toMatchObject({ id: "claude-code:5h", usedPercent: 100 });
  });

  it("sends the same Claude Code identity the CLI uses for this credential", async () => {
    let body: string | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(null, { status: 200, headers });
    });
    await fetchClaudeCodeUsage({
      db: dbStub,
      userWorkosId: "user_1",
      fetchImpl: fetchImpl as never,
    });
    expect(JSON.parse(String(body))).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    });
  });

  it("errors rather than claiming no limits when a reported window cannot be read", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
        }),
    );
    await expect(
      fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl }),
    ).rejects.toMatchObject({ kind: "backend_error", statusCode: 502 });
  });

  it("does not read a blank utilization header as a fully unused window", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { ...headers, "anthropic-ratelimit-unified-5h-utilization": "  " },
        }),
    );
    const result = await fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl });
    expect(result.windows.map((window) => window.id)).toEqual(["claude-code:7d"]);
  });

  it("reports no limits only when Anthropic reported no windows at all", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(
      fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl }),
    ).resolves.toEqual({ windows: [], updatedAt: expect.any(String) });
  });

  it("asks for a reconnect when the token is rejected", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(
      fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl }),
    ).rejects.toMatchObject({
      kind: "needs_reauth",
      statusCode: 401,
      message: "Reconnect Claude Code to view subscription usage.",
    });
  });

  it("never calls Anthropic without a connected credential", async () => {
    db.loadClaudeCodeCredential.mockResolvedValue(null);
    const fetchImpl = vi.fn();
    await expect(
      fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl }),
    ).rejects.toMatchObject({ kind: "needs_reauth" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a retryable error when Anthropic is unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(
      fetchClaudeCodeUsage({ db: dbStub, userWorkosId: "user_1", fetchImpl }),
    ).rejects.toMatchObject({ kind: "backend_error", statusCode: 503 });
  });
});
