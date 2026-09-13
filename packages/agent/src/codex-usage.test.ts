import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  loadCodexCredential: vi.fn(),
  markCodexCredentialNeedsReauth: vi.fn(),
  releaseCodexCredentialRefreshLock: vi.fn(),
  rotateCodexCredential: vi.fn(),
  tryAcquireCodexCredentialRefreshLock: vi.fn(),
}));
vi.mock("@opencompany/db/codex-auth", () => db);

import { fetchCodexUsage } from "./codex-usage";

const window = { used_percent: 35, reset_at: 2_000_000_000, limit_window_seconds: 18_000 };
const payload = {
  account_id: "acct_personal",
  rate_limit: {
    primary_window: window,
    secondary_window: { ...window, used_percent: 0, limit_window_seconds: 604_800 },
  },
  // Per-model side quotas the card deliberately drops; the fixture keeps sending them.
  additional_rate_limits: [
    { limit_name: "Codex Spark", rate_limit: { primary_window: { ...window, used_percent: 100 } } },
  ],
  email: "private@example.com",
  credits: { balance: "123" },
};
const credential = {
  status: "connected",
  lastRotatedAt: new Date("2026-01-01"),
  authJson: {
    tokens: {
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      account_id: "acct_personal",
    },
  },
};

describe("Codex subscription usage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.loadCodexCredential.mockResolvedValue(credential);
  });

  it("reports the plan windows only, ignoring per-model side quotas", async () => {
    const fetchImpl = vi.fn(async () => Response.json(payload));
    const result = await fetchCodexUsage({ db: {}, userWorkosId: "user_personal", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer access-secret",
          "ChatGPT-Account-Id": "acct_personal",
          Accept: "application/json",
        },
        signal: expect.any(AbortSignal),
        redirect: "error",
        cache: "no-store",
      }),
    );
    expect(db.loadCodexCredential).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_personal" }),
    );
    expect(result).toEqual({
      updatedAt: expect.any(String),
      windows: [
        {
          id: "codex:primary_window",
          label: "5-hour",
          usedPercent: 35,
          resetsAt: "2033-05-18T03:33:20.000Z",
        },
        {
          id: "codex:secondary_window",
          label: "Weekly",
          usedPercent: 0,
          resetsAt: "2033-05-18T03:33:20.000Z",
        },
      ],
    });
    expect(db.tryAcquireCodexCredentialRefreshLock).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { rate_limit: null },
    { rate_limit: { primary_window: null, secondary_window: null } },
  ])("keeps absent windows unavailable rather than inventing zero usage", async (body) => {
    const result = await fetchCodexUsage({
      db: {},
      userWorkosId: "user_personal",
      fetchImpl: async () => Response.json(body),
    });
    expect(result.windows).toEqual([]);
  });

  it.each([
    { rate_limit: { primary_window: { ...window, used_percent: -1 } } },
    { rate_limit: { primary_window: { ...window, reset_at: "tomorrow" } } },
    { rate_limit: { primary_window: { ...window, limit_window_seconds: 0 } } },
    { ...payload, account_id: "acct_someone_else" },
  ])("rejects invalid or mismatched data", async (body) => {
    await expect(
      fetchCodexUsage({
        db: {},
        userWorkosId: "user_personal",
        fetchImpl: async () => Response.json(body),
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("refreshes once through the existing credential lease after a 401", async () => {
    db.tryAcquireCodexCredentialRefreshLock.mockResolvedValue({ lockId: "lock_1" });
    db.rotateCodexCredential.mockResolvedValue(true);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ access_token: "new-access", refresh_token: "new-refresh" }),
      )
      .mockResolvedValueOnce(Response.json(payload));
    await fetchCodexUsage({ db: {}, userWorkosId: "user_personal", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://auth.openai.com/oauth/token");
    expect(new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer new-access",
    );
    expect(db.rotateCodexCredential).toHaveBeenCalledOnce();
    expect(db.releaseCodexCredentialRefreshLock).toHaveBeenCalledWith(
      expect.objectContaining({ lockId: "lock_1" }),
    );
  });

  it.each([403, 429, 500])(
    "does not invalidate inference credentials on usage HTTP %i",
    async (status) => {
      await expect(
        fetchCodexUsage({
          db: {},
          userWorkosId: "user_personal",
          fetchImpl: async () => new Response("private upstream details", { status }),
        }),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(db.markCodexCredentialNeedsReauth).not.toHaveBeenCalled();
      expect(db.tryAcquireCodexCredentialRefreshLock).not.toHaveBeenCalled();
    },
  );

  it("does not request provider usage for a disconnected account", async () => {
    db.loadCodexCredential.mockResolvedValue(null);
    const fetchImpl = vi.fn();
    await expect(
      fetchCodexUsage({ db: {}, userWorkosId: "user_personal", fetchImpl }),
    ).rejects.toMatchObject({ kind: "needs_reauth" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
