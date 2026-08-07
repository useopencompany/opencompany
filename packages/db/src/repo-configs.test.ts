import { type EncryptedPayload, EncryptionKeyConfigError } from "@opencompany/crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoatRepoConfigDb } from "./repo-configs";
import {
  isValidGitHubRepositoryExternalId,
  isValidGitHubRepositoryFullName,
  listDecryptedGoatRepoConfigs,
  upsertGoatRepoConfig,
} from "./repo-configs";

describe("Goat repository configs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("derives env keys, encrypts values, and binds decryption to the stable repository id", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    let insertedValues: Record<string, unknown> = {};
    let conflictSet: Record<string, unknown> | null = null;
    const now = new Date("2026-07-29T10:00:00Z");
    const insertDb = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues = values;
          return {
            onConflictDoUpdate: (options: { set: Record<string, unknown> }) => {
              conflictSet = options.set;
              return {
                returning: async () => [
                  {
                    repositoryExternalId: "123",
                    repositoryFullName: "opencompany/app",
                    envKeys: ["DATABASE_URL", "API_TOKEN"],
                    setupInstructions: "",
                    updatedAt: now,
                  },
                ],
              };
            },
          };
        },
      }),
    } as unknown as GoatRepoConfigDb;

    await upsertGoatRepoConfig({
      db: insertDb,
      workspaceId: "goat_ws_1",
      repositoryExternalId: "123",
      repositoryFullName: "opencompany/app",
      createdByWorkosId: "user_1",
      env: {
        content: "DATABASE_URL=database-secret-value\nAPI_TOKEN=token_secret",
      },
      now,
    });

    expect(insertedValues).toMatchObject({
      repositoryExternalId: "123",
      envKeys: ["DATABASE_URL", "API_TOKEN"],
    });
    expect(JSON.stringify(insertedValues)).not.toContain("database-secret-value");
    expect(JSON.stringify(insertedValues)).not.toContain("token_secret");
    expect(conflictSet).toMatchObject({ repositoryFullName: "opencompany/app" });
    expect(conflictSet).not.toHaveProperty("setupInstructions");

    const encryptedEnvPayload = insertedValues.encryptedEnvPayload as EncryptedPayload;
    const selectDb = selectRowsDb([
      {
        workspaceId: "goat_ws_1",
        repositoryExternalId: "123",
        repositoryFullName: "opencompany/renamed-app",
        encryptedEnvPayload,
        encryptionKeyVersion: 1,
        envKeys: ["DATABASE_URL", "API_TOKEN"],
        setupInstructions: "Run bun install.",
        updatedAt: now,
      },
    ]);
    await expect(
      listDecryptedGoatRepoConfigs({ db: selectDb.db, workspaceId: "goat_ws_1" }),
    ).resolves.toEqual([
      {
        repositoryExternalId: "123",
        repositoryFullName: "opencompany/renamed-app",
        envKeys: ["DATABASE_URL", "API_TOKEN"],
        setupInstructions: "Run bun install.",
        updatedAt: now,
        envContent: "DATABASE_URL=database-secret-value\nAPI_TOKEN=token_secret",
      },
    ]);
    expect(selectDb.innerJoin).toHaveBeenCalledTimes(2);
    const joinQueries = selectDb.innerJoin.mock.calls.map((call) =>
      new PgDialect().sqlToQuery(call[1] as SQL),
    );
    expect(joinQueries[0]?.sql).toContain(
      '"external_id" = "goat"."repo_configs"."repository_external_id"',
    );
    expect(joinQueries[0]?.params).toEqual(["github", "repository", "available"]);
    expect(joinQueries[1]?.sql).toContain('"workspace_id" = "goat"."repo_configs"."workspace_id"');
    expect(joinQueries[1]?.params).toEqual(["github", "connected"]);
  });

  it("skips a row that cannot be decrypted without dropping valid available rows", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const now = new Date("2026-07-29T10:00:00Z");
    let insertedValues: Record<string, unknown> = {};
    const insertDb = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues = values;
          return {
            onConflictDoUpdate: () => ({
              returning: async () => [
                {
                  repositoryExternalId: "123",
                  repositoryFullName: "opencompany/app",
                  envKeys: ["API_TOKEN"],
                  setupInstructions: "",
                  updatedAt: now,
                },
              ],
            }),
          };
        },
      }),
    } as unknown as GoatRepoConfigDb;
    await upsertGoatRepoConfig({
      db: insertDb,
      workspaceId: "goat_ws_1",
      repositoryExternalId: "123",
      repositoryFullName: "opencompany/app",
      createdByWorkosId: "user_1",
      env: { content: "API_TOKEN=token_secret" },
      now,
    });

    const encryptedEnvPayload = insertedValues.encryptedEnvPayload as EncryptedPayload;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = selectRowsDb([
      {
        workspaceId: "goat_ws_1",
        repositoryExternalId: "456",
        repositoryFullName: "opencompany/tampered",
        encryptedEnvPayload,
        encryptionKeyVersion: 1,
        envKeys: ["API_TOKEN"],
        setupInstructions: "",
        updatedAt: now,
      },
      {
        workspaceId: "goat_ws_1",
        repositoryExternalId: "123",
        repositoryFullName: "opencompany/app",
        encryptedEnvPayload,
        encryptionKeyVersion: 1,
        envKeys: ["API_TOKEN"],
        setupInstructions: "",
        updatedAt: now,
      },
    ]);

    await expect(listDecryptedGoatRepoConfigs({ db, workspaceId: "goat_ws_1" })).resolves.toEqual([
      expect.objectContaining({
        repositoryExternalId: "123",
        envContent: "API_TOKEN=token_secret",
      }),
    ]);
    expect(consoleError).toHaveBeenCalledWith(
      "[goat] Skipping invalid repository bootstrap configuration",
      {
        workspaceId: "goat_ws_1",
        repositoryExternalId: "456",
        errorName: "Error",
      },
    );
  });

  it("surfaces a missing encryption key instead of silently omitting repository setup", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "");
    const { db } = selectRowsDb([
      {
        workspaceId: "goat_ws_1",
        repositoryExternalId: "123",
        repositoryFullName: "opencompany/app",
        encryptedEnvPayload: {
          algorithm: "aes-256-gcm",
          iv: "invalid",
          ciphertext: "invalid",
          authTag: "invalid",
        },
        encryptionKeyVersion: 1,
        envKeys: ["API_TOKEN"],
        setupInstructions: "",
        updatedAt: new Date("2026-07-29T10:00:00Z"),
      },
    ]);

    await expect(
      listDecryptedGoatRepoConfigs({ db, workspaceId: "goat_ws_1" }),
    ).rejects.toBeInstanceOf(EncryptionKeyConfigError);
  });

  it("accepts GitHub ids and names but rejects unsafe identifiers", () => {
    expect(isValidGitHubRepositoryExternalId("123456")).toBe(true);
    expect(isValidGitHubRepositoryExternalId("repo_123")).toBe(false);
    expect(isValidGitHubRepositoryFullName("opencompany/app")).toBe(true);
    expect(isValidGitHubRepositoryFullName("../app")).toBe(false);
    expect(isValidGitHubRepositoryFullName("opencompany/..")).toBe(false);
    expect(isValidGitHubRepositoryFullName("opencompany/app/extra")).toBe(false);
  });
});

function selectRowsDb(rows: unknown[]): {
  db: GoatRepoConfigDb;
  innerJoin: ReturnType<typeof vi.fn>;
} {
  const innerJoin = vi.fn();
  const query = {
    innerJoin,
    where: () => query,
    orderBy: async () => rows,
  };
  innerJoin.mockImplementation(() => query);
  return {
    db: {
      select: () => ({
        from: () => query,
      }),
    } as unknown as GoatRepoConfigDb,
    innerJoin,
  };
}
