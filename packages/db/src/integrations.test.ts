import { decryptJson } from "@opencompany/crypto";
import { drizzle } from "drizzle-orm/neon-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectGoatSlackBotIntegration,
  goatCredentialAad,
  refreshGoatIntegrationCredential,
} from "./integrations";

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

describe("connectGoatSlackBotIntegration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("upserts one bot integration per Goat workspace and updates its Slack team", async () => {
    const encryptionKey = Buffer.alloc(32, 7);
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", encryptionKey.toString("base64"));
    const now = new Date("2026-07-16T10:00:00.000Z");
    const transaction = vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries));
    const query = vi.fn(async (statement: string, _params: unknown[], _options: object) => ({
      rows: statement.startsWith('select "id", "user_workos_id" from "goat"."integrations"')
        ? [["gint_existing", "user_original"]]
        : statement.startsWith('insert into "goat"."integrations"')
          ? [["gint_existing"]]
          : [["gcred_123", null, now.toISOString(), now.toISOString(), 1]],
    }));
    const client = Object.assign(query, { transaction });
    const db = drizzle(client as never);

    await expect(
      connectGoatSlackBotIntegration({
        userWorkosId: "user_reconnecting",
        workspaceId: "workspace_123",
        teamId: "T_NEW",
        teamName: "New Slack",
        botUserId: "B_NEW",
        accessToken: "xoxb-test",
        scopes: ["app_mentions:read", "chat:write"],
        db,
        now,
      }),
    ).resolves.toEqual({ integrationId: "gint_existing" });

    expect(query).toHaveBeenCalledTimes(3);
    expect(transaction).toHaveBeenCalledOnce();
    const integrationCall = query.mock.calls.find(([statement]) =>
      statement.startsWith('insert into "goat"."integrations"'),
    );
    const credentialCall = query.mock.calls.find(([statement]) =>
      statement.startsWith('insert into "goat"."integration_credentials"'),
    );
    expect(integrationCall).toBeDefined();
    expect(credentialCall).toBeDefined();

    const [integrationStatement, integrationParams] = integrationCall!;
    const normalized = integrationStatement.replace(/\s+/g, " ");
    expect(normalized).toContain('on conflict ("workspace_id","provider")');
    expect(normalized).toContain("\"provider\" = 'slack_bot'");
    expect(normalized).toContain('do update set "external_id" =');
    expect(integrationParams).toEqual(
      expect.arrayContaining(["workspace_123", "T_NEW", "New Slack"]),
    );
    expect(integrationParams.some((value) => String(value).includes("app_mentions:read"))).toBe(
      true,
    );

    const [, credentialParams] = credentialCall!;
    expect(credentialParams).toEqual(
      expect.arrayContaining(["user_original", "gint_existing", "slack_bot", "oauth_token"]),
    );
    const encryptedParam = credentialParams.find(
      (value) => typeof value === "string" && value.includes('"ciphertext"'),
    );
    expect(encryptedParam).toBeTypeOf("string");
    expect(encryptedParam).not.toContain("xoxb-test");
    expect(
      decryptJson(JSON.parse(encryptedParam as string), {
        key: encryptionKey,
        aad: goatCredentialAad({
          userWorkosId: "user_original",
          integrationId: "gint_existing",
          provider: "slack_bot",
          kind: "oauth_token",
          keyVersion: 1,
        }),
      }),
    ).toEqual({
      access_token: "xoxb-test",
      bot_user_id: "B_NEW",
      team_id: "T_NEW",
      team_name: "New Slack",
      scope: "app_mentions:read,chat:write",
    });
  });
});
