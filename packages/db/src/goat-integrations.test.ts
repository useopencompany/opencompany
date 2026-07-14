import { drizzle } from "drizzle-orm/neon-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshGoatIntegrationCredential } from "./goat-integrations";

describe("refreshGoatIntegrationCredential", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refreshes atomically through the neon-http driver without an interactive transaction", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const now = new Date("2026-07-14T09:15:00.000Z");
    const expiresAt = new Date("2026-07-14T10:15:00.000Z");
    const transaction = vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries));
    const query = vi.fn(async (statement: string, _params: unknown[], _options: object) => ({
      rows: statement.startsWith('insert into "goat"."integration_credentials"')
        ? [["gcred_123", expiresAt.toISOString(), now.toISOString(), now.toISOString(), 1]]
        : [],
    }));
    const client = Object.assign(query, { transaction });
    const db = drizzle(client as never);

    await expect(
      refreshGoatIntegrationCredential({
        userWorkosId: "user_123",
        integrationId: "gint_123",
        provider: "google_drive",
        kind: "oauth_token",
        payload: { access_token: "refreshed", refresh_token: "refresh" },
        expiresAt,
        db,
        now,
      }),
    ).resolves.toEqual({
      id: "gcred_123",
      expiresAt,
      lastRotatedAt: now,
      updatedAt: now,
      encryptionKeyVersion: 1,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledOnce();
    const [insertStatement, insertParams, insertOptions] = query.mock.calls[0]!;
    const [updateStatement, updateParams, updateOptions] = query.mock.calls[1]!;
    expect(insertStatement).toContain('insert into "goat"."integration_credentials"');
    expect(insertStatement).toContain("on conflict");
    expect(updateStatement).toContain('update "goat"."integrations"');
    expect([...insertParams, ...updateParams]).toEqual(
      expect.arrayContaining([
        "user_123",
        "gint_123",
        "google_drive",
        "oauth_token",
        expiresAt.toISOString(),
        now.toISOString(),
      ]),
    );
    expect(insertOptions).toMatchObject({ arrayMode: true, fullResults: true });
    expect(updateOptions).toMatchObject({ arrayMode: true, fullResults: true });
  });

  it("rejects when the credential write returns no row", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const transaction = vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries));
    const query = vi.fn(async (_statement: string, _params: unknown[], _options: object) => ({
      rows: [],
    }));
    const client = Object.assign(query, { transaction });
    const db = drizzle(client as never);

    await expect(
      refreshGoatIntegrationCredential({
        userWorkosId: "user_123",
        integrationId: "gint_missing",
        provider: "google_drive",
        kind: "oauth_token",
        payload: { access_token: "refreshed", refresh_token: "refresh" },
        expiresAt: new Date("2026-07-14T10:15:00.000Z"),
        db,
        now: new Date("2026-07-14T09:15:00.000Z"),
      }),
    ).rejects.toThrow("Could not refresh Goat integration credential.");

    expect(query).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledOnce();
  });
});
