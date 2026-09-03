import { decryptJson } from "@opencompany/crypto";
import { drizzle } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyIntegrationCapabilityMode,
  claimIntegrationCredentialRefresh,
  connectGitHubUserIntegration,
  connectSlackBotIntegration,
  credentialAad,
  disconnectPersonalIntegration,
  refreshIntegrationCredential,
  rotateIntegrationCredential,
} from "./integrations";

describe("connectGitHubUserIntegration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("upserts one personal github_user row and encrypts the rotating token pair", async () => {
    const encryptionKey = Buffer.alloc(32, 7);
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", encryptionKey.toString("base64"));
    const now = new Date("2026-09-01T12:00:00.000Z");
    const accessTokenExpiresAt = new Date("2026-09-01T20:00:00.000Z");
    const refreshTokenExpiresAt = new Date("2027-03-04T12:00:00.000Z");
    const query = vi.fn(async (statement: string, _params: unknown[], _options: object) => ({
      rows: statement.startsWith('insert into "goat"."integrations"')
        ? [["gint_github_user"]]
        : [
            [
              "gcred_github_user",
              accessTokenExpiresAt.toISOString(),
              now.toISOString(),
              now.toISOString(),
              1,
            ],
          ],
    }));
    const db = drizzle(query as never);

    await expect(
      connectGitHubUserIntegration({
        userWorkosId: "user_1",
        githubUserId: "42",
        login: "octocat",
        name: "The Octocat",
        email: null,
        installationId: "123",
        accessToken: "ghu_access",
        refreshToken: "ghr_refresh",
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        tokenType: "bearer",
        db,
        now,
      }),
    ).resolves.toEqual({ integrationId: "gint_github_user" });

    const [integrationStatement, integrationParams] = query.mock.calls[0]!;
    expect(integrationStatement.replace(/\s+/g, " ")).toContain(
      'on conflict ("user_workos_id","provider","external_id")',
    );
    expect(integrationParams).toEqual(
      expect.arrayContaining([
        "user_1",
        "github_user",
        "@octocat",
        "The Octocat",
        "42+octocat@users.noreply.github.com",
      ]),
    );

    const [, credentialParams] = query.mock.calls[1]!;
    const encryptedParam = credentialParams.find(
      (value) => typeof value === "string" && value.includes('"ciphertext"'),
    );
    expect(encryptedParam).toBeTypeOf("string");
    expect(encryptedParam).not.toContain("ghu_access");
    expect(
      decryptJson(JSON.parse(encryptedParam as string), {
        key: encryptionKey,
        aad: credentialAad({
          userWorkosId: "user_1",
          integrationId: "gint_github_user",
          provider: "github_user",
          kind: "oauth_token",
          keyVersion: 1,
        }),
      }),
    ).toEqual({
      access_token: "ghu_access",
      refresh_token: "ghr_refresh",
      token_type: "bearer",
      refresh_token_expires_at: refreshTokenExpiresAt.toISOString(),
      github_user_id: "42",
      github_login: "octocat",
      github_installation_id: "123",
    });
  });
});

describe("refreshIntegrationCredential", () => {
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
      refreshIntegrationCredential({
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
      refreshIntegrationCredential({
        userWorkosId: "user_123",
        integrationId: "gint_missing",
        provider: "google_drive",
        kind: "oauth_token",
        payload: { access_token: "refreshed", refresh_token: "refresh" },
        expiresAt: new Date("2026-07-14T10:15:00.000Z"),
        db,
        now: new Date("2026-07-14T09:15:00.000Z"),
      }),
    ).rejects.toThrow("Could not refresh opencompany integration credential.");

    expect(query).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledOnce();
  });
});

describe("integration credential refresh leases", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("claims one expired OAuth rotation by its current rotation timestamp", async () => {
    const query = vi.fn(async (_statement: string, _params: unknown[], _options: object) => ({
      rows: [["gcred_123"]],
    }));
    const db = drizzle(query as never);
    const lastRotatedAt = new Date("2026-09-01T11:00:00.000Z");
    const now = new Date("2026-09-01T12:00:00.000Z");
    const leaseUntil = new Date("2026-09-01T12:00:30.000Z");

    await expect(
      claimIntegrationCredentialRefresh({
        userWorkosId: "user_123",
        integrationId: "gint_123",
        provider: "github_user",
        kind: "oauth_token",
        expectedLastRotatedAt: lastRotatedAt,
        leaseUntil,
        db,
        now,
      }),
    ).resolves.toBe(true);

    const [statement, params] = query.mock.calls[0]!;
    expect(statement.replace(/\s+/g, " ")).toContain(
      'update "goat"."integration_credentials" set "refresh_lease_until" =',
    );
    expect(statement).toContain('"last_rotated_at" =');
    expect(statement).toContain('"refresh_lease_until" is null');
    expect(params).toEqual(
      expect.arrayContaining([
        "user_123",
        "gint_123",
        "github_user",
        "oauth_token",
        lastRotatedAt.toISOString(),
        now.toISOString(),
        leaseUntil.toISOString(),
      ]),
    );
  });

  it("rotates only the credential that owns the lease and clears the lease", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const now = new Date("2026-09-01T12:00:00.000Z");
    const previousRotation = new Date("2026-09-01T11:00:00.000Z");
    const leaseUntil = new Date("2026-09-01T12:00:30.000Z");
    const expiresAt = new Date("2026-09-01T20:00:00.000Z");
    const query = vi.fn(async (statement: string, _params: unknown[], _options: object) => ({
      rows: statement.startsWith('update "goat"."integration_credentials"')
        ? [["gcred_123", expiresAt.toISOString(), now.toISOString(), now.toISOString(), 1]]
        : [],
    }));
    const db = drizzle(query as never);

    await expect(
      rotateIntegrationCredential({
        userWorkosId: "user_123",
        integrationId: "gint_123",
        provider: "github_user",
        kind: "oauth_token",
        payload: { access_token: "ghu_rotated", refresh_token: "ghr_rotated" },
        expiresAt,
        expectedLastRotatedAt: previousRotation,
        expectedRefreshLeaseUntil: leaseUntil,
        db,
        now,
      }),
    ).resolves.toMatchObject({ id: "gcred_123", expiresAt });

    const [statement, params] = query.mock.calls[0]!;
    const normalized = statement.replace(/\s+/g, " ");
    expect(normalized).toContain('update "goat"."integration_credentials"');
    expect(normalized).toContain('"refresh_lease_until" = $');
    expect(normalized).toContain('and "goat"."integration_credentials"."refresh_lease_until" =');
    expect(params).toEqual(
      expect.arrayContaining([
        "user_123",
        "gint_123",
        "github_user",
        "oauth_token",
        previousRotation.toISOString(),
        leaseUntil.toISOString(),
      ]),
    );
  });
});

describe("connectSlackBotIntegration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("upserts one bot integration per opencompany workspace and updates its Slack team", async () => {
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
      connectSlackBotIntegration({
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
        aad: credentialAad({
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

  it("falls back to an interactive transaction on drivers without a batch API", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const now = new Date("2026-08-13T09:00:00.000Z");
    const statements: string[] = [];
    // node-postgres client shape: drizzle's pooled session drives BEGIN/COMMIT
    // through client.query, unlike neon-http's batch endpoint.
    const query = vi.fn(
      async (config: string | { text: string }, _params?: unknown[], _options?: object) => {
        const text = typeof config === "string" ? config : config.text;
        statements.push(text);
        if (text.startsWith('select "id", "user_workos_id" from "goat"."integrations"')) {
          return { rows: [] };
        }
        if (text.startsWith('insert into "goat"."integrations"')) {
          return { rows: [["gint_bot_new"]] };
        }
        if (text.startsWith('insert into "goat"."integration_credentials"')) {
          return { rows: [["gcred_bot", null, now.toISOString(), now.toISOString(), 1]] };
        }
        return { rows: [] };
      },
    );
    const db = drizzleNodePg({ query } as never);

    await expect(
      connectSlackBotIntegration({
        userWorkosId: "user_connecting",
        workspaceId: "workspace_123",
        teamId: "T_NEW",
        teamName: "New Slack",
        botUserId: "B_NEW",
        accessToken: "xoxb-test",
        scopes: ["app_mentions:read", "chat:write"],
        db,
        now,
      }),
    ).resolves.toEqual({ integrationId: "gint_bot_new" });

    // Both writes must sit inside one interactive transaction.
    const begin = statements.findIndex((text) => text === "begin");
    const commit = statements.findIndex((text) => text === "commit");
    const integrationInsert = statements.findIndex((text) =>
      text.startsWith('insert into "goat"."integrations"'),
    );
    const credentialInsert = statements.findIndex((text) =>
      text.startsWith('insert into "goat"."integration_credentials"'),
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(integrationInsert).toBeGreaterThan(begin);
    expect(credentialInsert).toBeGreaterThan(integrationInsert);
    expect(commit).toBeGreaterThan(credentialInsert);
    expect(statements[integrationInsert]!.replace(/\s+/g, " ")).toContain(
      'on conflict ("workspace_id","provider")',
    );
  });
});

describe("disconnectPersonalIntegration", () => {
  it("reports a deletion for both drizzle execute result shapes", async () => {
    // node-postgres pooled drizzle returns { rows }; neon-http returns arrays.
    const pooled = { execute: vi.fn(async () => ({ rows: [{ id: "gint_1" }] })) };
    await expect(
      disconnectPersonalIntegration({
        userWorkosId: "user_1",
        integrationId: "gint_1",
        db: pooled,
      }),
    ).resolves.toBe(true);

    const arrayShaped = { execute: vi.fn(async () => [{ id: "gint_1" }]) };
    await expect(
      disconnectPersonalIntegration({
        userWorkosId: "user_1",
        integrationId: "gint_1",
        db: arrayShaped,
      }),
    ).resolves.toBe(true);
  });

  it("reports no deletion when the ownership guard matches nothing", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [] })) };
    await expect(
      disconnectPersonalIntegration({
        userWorkosId: "user_1",
        integrationId: "gint_other",
        db,
      }),
    ).resolves.toBe(false);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

describe("applyIntegrationCapabilityMode", () => {
  it("merges the sparse override and stamps updatedAt", async () => {
    let setValues: Record<string, unknown> | null = null;
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          setValues = values;
          return { where: async () => undefined };
        },
      }),
    };
    const now = new Date("2026-08-13T08:00:00.000Z");
    await applyIntegrationCapabilityMode({
      integrationIds: ["gint_1", "gint_2"],
      capabilityId: "write",
      mode: "on",
      db: db as never,
      now,
    });
    expect(setValues).not.toBeNull();
    expect((setValues as unknown as { updatedAt: Date }).updatedAt).toEqual(now);
  });

  it("skips the write entirely for an empty connection list", async () => {
    const update = vi.fn();
    await applyIntegrationCapabilityMode({
      integrationIds: [],
      capabilityId: "write",
      mode: "on",
      db: { update } as never,
    });
    expect(update).not.toHaveBeenCalled();
  });
});
