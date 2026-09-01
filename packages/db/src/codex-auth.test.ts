import { drizzle } from "drizzle-orm/neon-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadCodexAuthStatus,
  loadFreshCodexAccessToken,
  rotateCodexCredential,
  saveCodexCredential,
} from "./codex-auth";

describe("rotateCodexCredential", () => {
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
      rotateCodexCredential({
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
      rotateCodexCredential({
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

  it("reads status fields without touching the encrypted payload", async () => {
    const row = {
      status: "connected" as const,
      statusReason: null,
      lastValidatedAt: new Date("2026-08-01T13:00:00.000Z"),
      lastRotatedAt: null,
    };
    const limit = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    await expect(
      loadCodexAuthStatus({ db: { select } as never, userWorkosId: "user_123" }),
    ).resolves.toEqual(row);
    // The status projection never selects the encrypted auth JSON.
    expect(select).toHaveBeenCalledWith(
      expect.not.objectContaining({ encryptedAuthJson: expect.anything() }),
    );
  });

  it("refreshes near-expiry OAuth tokens under an advisory lock and reuses the winner", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const now = new Date("2026-09-01T12:00:00.000Z");
    const initialAccessToken = jwt({ exp: Math.floor(now.getTime() / 1000) + 30 });
    const refreshedAccessToken = jwt({ exp: Math.floor(now.getTime() / 1000) + 3_600 });
    const db = inMemoryCodexDb();
    await saveCodexCredential({
      db: db as never,
      userWorkosId: "user_123",
      authJson: {
        tokens: {
          access_token: initialAccessToken,
          refresh_token: "refresh-one",
          account_id: "account-one",
        },
      },
      now: new Date("2026-09-01T11:00:00.000Z"),
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: refreshedAccessToken,
            refresh_token: "refresh-two",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof fetch;

    await expect(
      loadFreshCodexAccessToken({
        db,
        userWorkosId: "user_123",
        fetchImpl,
        now,
      }),
    ).resolves.toMatchObject({
      accessToken: refreshedAccessToken,
      accountId: "account-one",
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          grant_type: "refresh_token",
          refresh_token: "refresh-one",
        }),
      }),
    );

    await expect(
      loadFreshCodexAccessToken({
        db,
        userWorkosId: "user_123",
        rejectedAccessToken: initialAccessToken,
        fetchImpl,
        now,
      }),
    ).resolves.toMatchObject({ accessToken: refreshedAccessToken });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function jwt(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function inMemoryCodexDb() {
  let stored: Record<string, unknown> | null = null;
  const db: any = {
    execute: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            stored = { ...values };
            return [
              {
                userWorkosId: values.userWorkosId,
                lastValidatedAt: values.lastValidatedAt,
                lastRotatedAt: values.lastRotatedAt,
                updatedAt: values.updatedAt,
              },
            ];
          },
        }),
      }),
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (stored ? [{ ...stored }] : []),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (!stored) return [];
            stored = { ...stored, ...values };
            return [{ userWorkosId: stored.userWorkosId }];
          },
        }),
      }),
    })),
  };
  return db;
}
