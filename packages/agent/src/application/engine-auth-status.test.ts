import { loadClaudeCodeAuthStatus } from "@opencompany/db/claude-code-auth";
import { loadCodexAuthStatus } from "@opencompany/db/codex-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isClaudeCodeConnectedForUser, isCodexConnectedForUser } from "./engine-auth-status";

vi.mock("@opencompany/db/claude-code-auth", () => ({
  loadClaudeCodeAuthStatus: vi.fn(async () => null),
}));
vi.mock("@opencompany/db/codex-auth", () => ({
  loadCodexAuthStatus: vi.fn(async () => null),
}));

describe("engine auth status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the explicit persistence handle for sessionless Codex reads", async () => {
    const db = { sentinel: "db" } as never;
    vi.mocked(loadCodexAuthStatus).mockResolvedValueOnce({
      status: "connected",
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
    });

    await expect(isCodexConnectedForUser("user_1", db)).resolves.toBe(true);
    expect(loadCodexAuthStatus).toHaveBeenCalledWith({ db, userWorkosId: "user_1" });
  });

  it("treats missing and reauth-required Claude credentials as disconnected", async () => {
    const db = { sentinel: "db" } as never;
    vi.mocked(loadClaudeCodeAuthStatus).mockResolvedValueOnce({
      status: "needs_reauth",
      statusReason: "expired",
      lastValidatedAt: null,
      lastRotatedAt: null,
    });

    await expect(isClaudeCodeConnectedForUser("user_1", db)).resolves.toBe(false);
    vi.mocked(loadClaudeCodeAuthStatus).mockResolvedValueOnce(null);
    await expect(isClaudeCodeConnectedForUser("user_1", db)).resolves.toBe(false);
  });
});
