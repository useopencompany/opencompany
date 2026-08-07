import { afterEach, describe, expect, it, vi } from "vitest";
import { markClaudeCodeCredentialValidated, saveClaudeCodeCredential } from "./claude-code-auth";

describe("Claude Code credential validation state", () => {
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

    await saveClaudeCodeCredential({
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
      markClaudeCodeCredentialValidated({
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
      markClaudeCodeCredentialValidated({
        db: db as never,
        userWorkosId: "user_123",
        expectedUpdatedAt: new Date("2026-07-28T10:00:00.000Z"),
      }),
    ).resolves.toBe(false);
  });
});
