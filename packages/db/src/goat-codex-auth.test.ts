import { drizzle } from "drizzle-orm/neon-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rotateGoatCodexCredential } from "./goat-codex-auth";

describe("rotateGoatCodexCredential", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("only rotates the credential version loaded by the runner", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const expectedLastRotatedAt = new Date("2026-08-01T12:00:00.000Z");
    const now = new Date("2026-08-01T13:00:00.000Z");
    const query = vi.fn(async (_statement: string, _params: unknown[]) => ({
      rows: [["user_123"]],
    }));
    const db = drizzle(query as never);

    await expect(
      rotateGoatCodexCredential({
        db,
        userWorkosId: "user_123",
        authJson: { tokens: { refresh_token: "refreshed" } },
        expectedLastRotatedAt,
        now,
      }),
    ).resolves.toBe(true);

    const [statement, params] = query.mock.calls[0]!;
    expect(statement).toContain('update "goat"."codex_credentials"');
    expect(statement).toContain('"last_rotated_at" =');
    expect(params).toEqual(
      expect.arrayContaining(["user_123", expectedLastRotatedAt.toISOString(), now.toISOString()]),
    );
  });

  it("does not rotate when another runner already saved a newer credential", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const query = vi.fn(async (_statement: string, _params: unknown[]) => ({ rows: [] }));
    const db = drizzle(query as never);

    await expect(
      rotateGoatCodexCredential({
        db,
        userWorkosId: "user_123",
        authJson: { tokens: { refresh_token: "stale" } },
        expectedLastRotatedAt: null,
        now: new Date("2026-08-01T13:00:00.000Z"),
      }),
    ).resolves.toBe(false);

    const [statement] = query.mock.calls[0]!;
    expect(statement).toContain('"last_rotated_at" is null');
  });
});
