import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadGoatClaudeCodeAuthStatus,
  markGoatClaudeCodeCredentialValidated,
  saveGoatClaudeCodeCredential,
} from "./goat-claude-code-auth";

describe("Goat Claude Code credential validation state", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores a newly pasted token without claiming it was validated", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const now = new Date("2026-07-28T10:00:00.000Z");
    const returning = vi.fn(async () => [
      {
        userWorkosId: "user_123",
        lastValidatedAt: null,
        lastRotatedAt: now,
        updatedAt: now,
      },
    ]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const db = { insert: vi.fn(() => ({ values })) };

    await saveGoatClaudeCodeCredential({
      db: db as never,
      userWorkosId: "user_123",
      authJson: { token: "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz" },
      validatedAt: null,
      now,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_123",
        status: "connected",
        lastValidatedAt: null,
        lastRotatedAt: now,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ lastValidatedAt: null, updatedAt: now }),
      }),
    );
  });

  it("marks only the unchanged credential as validated", async () => {
    const now = new Date("2026-07-28T10:05:00.000Z");
    const returning = vi.fn(async () => [{ userWorkosId: "user_123" }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) };

    await expect(
      markGoatClaudeCodeCredentialValidated({
        db: db as never,
        userWorkosId: "user_123",
        expectedUpdatedAt: new Date("2026-07-28T10:00:00.000Z"),
        now,
      }),
    ).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith({
      status: "connected",
      statusReason: null,
      lastValidatedAt: now,
      updatedAt: now,
    });
    expect(where).toHaveBeenCalledOnce();
  });

  it("does not validate a credential that changed during the Claude turn", async () => {
    const returning = vi.fn(async () => []);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) };

    await expect(
      markGoatClaudeCodeCredentialValidated({
        db: db as never,
        userWorkosId: "user_123",
        expectedUpdatedAt: new Date("2026-07-28T10:00:00.000Z"),
      }),
    ).resolves.toBe(false);
  });

  it("reads status fields without touching the encrypted payload", async () => {
    const row = {
      status: "needs_reauth" as const,
      statusReason: "Token expired.",
      lastValidatedAt: null,
      lastRotatedAt: new Date("2026-07-28T10:00:00.000Z"),
    };
    const limit = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select };

    await expect(
      loadGoatClaudeCodeAuthStatus({ db: db as never, userWorkosId: "user_123" }),
    ).resolves.toEqual(row);
    // The status projection never selects the encrypted auth JSON.
    expect(select).toHaveBeenCalledWith(
      expect.not.objectContaining({ encryptedAuthJson: expect.anything() }),
    );

    const empty = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
      })),
    };
    await expect(
      loadGoatClaudeCodeAuthStatus({ db: empty as never, userWorkosId: "user_123" }),
    ).resolves.toBeNull();
  });
});
