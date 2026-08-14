import { loadGoatClaudeCodeAuthStatus } from "@opencompany/db/goat-claude-code-auth";
import { loadGoatCodexAuthStatus } from "@opencompany/db/goat-codex-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGoatClaudeCodeConnectedForUser,
  isGoatCodexConnectedForUser,
} from "./engine-auth-status";

vi.mock("@opencompany/db/goat-claude-code-auth", () => ({
  loadGoatClaudeCodeAuthStatus: vi.fn(async () => null),
}));
vi.mock("@opencompany/db/goat-codex-auth", () => ({
  loadGoatCodexAuthStatus: vi.fn(async () => null),
}));

describe("engine auth status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the explicit persistence handle for sessionless Codex reads", async () => {
    const db = { sentinel: "db" } as never;
    vi.mocked(loadGoatCodexAuthStatus).mockResolvedValueOnce({
      status: "connected",
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
    });

    await expect(isGoatCodexConnectedForUser("user_1", db)).resolves.toBe(true);
    expect(loadGoatCodexAuthStatus).toHaveBeenCalledWith({ db, userWorkosId: "user_1" });
  });

  it("treats missing and reauth-required Claude credentials as disconnected", async () => {
    const db = { sentinel: "db" } as never;
    vi.mocked(loadGoatClaudeCodeAuthStatus).mockResolvedValueOnce({
      status: "needs_reauth",
      statusReason: "expired",
      lastValidatedAt: null,
      lastRotatedAt: null,
    });

    await expect(isGoatClaudeCodeConnectedForUser("user_1", db)).resolves.toBe(false);
    vi.mocked(loadGoatClaudeCodeAuthStatus).mockResolvedValueOnce(null);
    await expect(isGoatClaudeCodeConnectedForUser("user_1", db)).resolves.toBe(false);
  });
});
