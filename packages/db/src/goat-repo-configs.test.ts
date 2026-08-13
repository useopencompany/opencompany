import { type EncryptedPayload, EncryptionKeyConfigError } from "@opencompany/crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoatRepoConfigDb } from "./goat-repo-configs";
import {
  GOAT_REPO_ENV_MAX_BYTES,
  isValidGitHubRepositoryExternalId,
  isValidGitHubRepositoryFullName,
  listDecryptedGoatRepoConfigs,
  normalizeGoatRepoSetupInstructions,
  upsertGoatRepoConfig,
  validateGoatRepoEnv,
} from "./goat-repo-configs";

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

  it("accepts dotenv files with comments, quotes, multiline values, and equals signs", () => {
    const result = validateGoatRepoEnv(`# local setup
DATABASE_URL="database.example.test/db?sslmode=require"
TOKEN='abc=def'
export API_URL=https://example.test/api
PRIVATE_KEY="-----BEGIN KEY-----
line=inside-the-value
-----END KEY-----"
EMPTY=
`);

    expect(result).toEqual({ ok: true });
  });

  it("rejects empty and oversized env files without returning any values", () => {
    expect(validateGoatRepoEnv("# comments only")).toEqual({
      ok: false,
      message: "No environment variables were found.",
    });
    expect(validateGoatRepoEnv(`KEY=${"x".repeat(GOAT_REPO_ENV_MAX_BYTES)}`)).toEqual({
      ok: false,
      message: "Environment files must be 256 KB or smaller.",
    });
    expect(validateGoatRepoEnv(`${"K".repeat(257)}=value`)).toEqual({
      ok: false,
      message: "Environment variable names must be 256 characters or fewer.",
    });
  });

  it("trims setup instructions and bounds their length", () => {
    expect(normalizeGoatRepoSetupInstructions("  run bun install  ")).toEqual({
      ok: true,
      instructions: "run bun install",
    });
    expect(normalizeGoatRepoSetupInstructions("x".repeat(4_001))).toEqual({
      ok: false,
      message: "Setup instructions must be 4,000 characters or fewer.",
    });
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
