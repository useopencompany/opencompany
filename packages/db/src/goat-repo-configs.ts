import { randomUUID } from "node:crypto";
import {
  buildAad,
  DEFAULT_ENCRYPTION_KEY_VERSION,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  type EncryptedPayload,
  EncryptionKeyConfigError,
  encryptJson,
  loadEncryptionKey,
  UnsupportedKeyVersionError,
} from "@opencompany/crypto";
import { parse } from "dotenv";
import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as goatSchema from "./goat-schema";
import { goatIntegrationResources, goatIntegrations, goatRepoConfigs } from "./goat-schema";

const REPO_CONFIG_ENCRYPTION_KEY_VERSION = DEFAULT_ENCRYPTION_KEY_VERSION;

type DbSchema = typeof goatSchema;
export type GoatRepoConfigDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "delete" | "insert" | "select" | "update"
>;

export type GoatRepoConfigView = {
  repositoryExternalId: string;
  repositoryFullName: string;
  envKeys: string[];
  setupInstructions: string;
  updatedAt: Date;
};

export type DecryptedGoatRepoConfig = GoatRepoConfigView & {
  envContent: string | null;
};

export type GoatWorkspaceRepository = {
  repositoryExternalId: string;
  repositoryFullName: string;
  private: boolean;
};

export function isValidGitHubRepositoryExternalId(value: string): boolean {
  return /^[1-9]\d{0,63}$/.test(value);
}

export function isValidGitHubRepositoryFullName(value: string): boolean {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

export async function listGoatRepoConfigs(input: {
  db: GoatRepoConfigDb;
  workspaceId: string;
}): Promise<GoatRepoConfigView[]> {
  const rows = await input.db
    .select({
      repositoryExternalId: goatRepoConfigs.repositoryExternalId,
      repositoryFullName: goatRepoConfigs.repositoryFullName,
      envKeys: goatRepoConfigs.envKeys,
      setupInstructions: goatRepoConfigs.setupInstructions,
      updatedAt: goatRepoConfigs.updatedAt,
    })
    .from(goatRepoConfigs)
    .where(eq(goatRepoConfigs.workspaceId, input.workspaceId))
    .orderBy(asc(goatRepoConfigs.repositoryFullName));

  return rows.map((row) => ({
    repositoryExternalId: row.repositoryExternalId,
    repositoryFullName: row.repositoryFullName,
    envKeys: sanitizeEnvKeys(row.envKeys),
    setupInstructions: row.setupInstructions,
    updatedAt: row.updatedAt,
  }));
}

export async function listDecryptedGoatRepoConfigs(input: {
  db: GoatRepoConfigDb;
  workspaceId: string;
}): Promise<DecryptedGoatRepoConfig[]> {
  const rows = await input.db
    .select({
      workspaceId: goatRepoConfigs.workspaceId,
      repositoryExternalId: goatRepoConfigs.repositoryExternalId,
      repositoryFullName: goatIntegrationResources.name,
      encryptedEnvPayload: goatRepoConfigs.encryptedEnvPayload,
      encryptionKeyVersion: goatRepoConfigs.encryptionKeyVersion,
      envKeys: goatRepoConfigs.envKeys,
      setupInstructions: goatRepoConfigs.setupInstructions,
      updatedAt: goatRepoConfigs.updatedAt,
    })
    .from(goatRepoConfigs)
    .innerJoin(
      goatIntegrationResources,
      and(
        eq(goatIntegrationResources.externalId, goatRepoConfigs.repositoryExternalId),
        eq(goatIntegrationResources.provider, "github"),
        eq(goatIntegrationResources.resourceType, "repository"),
        eq(goatIntegrationResources.status, "available"),
      ),
    )
    .innerJoin(
      goatIntegrations,
      and(
        eq(goatIntegrations.id, goatIntegrationResources.integrationId),
        eq(goatIntegrations.workspaceId, goatRepoConfigs.workspaceId),
        eq(goatIntegrations.provider, "github"),
        eq(goatIntegrations.status, "connected"),
      ),
    )
    .where(eq(goatRepoConfigs.workspaceId, input.workspaceId))
    .orderBy(asc(goatIntegrationResources.name));

  const configs = new Map<string, DecryptedGoatRepoConfig>();
  for (const row of rows) {
    if (configs.has(row.repositoryExternalId)) continue;
    try {
      if (row.workspaceId !== input.workspaceId) {
        throw new Error("Repository configuration row did not match the requested workspace.");
      }
      if (!isValidGitHubRepositoryExternalId(row.repositoryExternalId)) {
        throw new Error("Repository configuration contains an invalid repository id.");
      }
      if (!isValidGitHubRepositoryFullName(row.repositoryFullName)) {
        throw new Error("Repository configuration contains an invalid repository name.");
      }

      configs.set(row.repositoryExternalId, {
        repositoryExternalId: row.repositoryExternalId,
        repositoryFullName: row.repositoryFullName,
        envKeys: sanitizeEnvKeys(row.envKeys),
        setupInstructions: row.setupInstructions,
        updatedAt: row.updatedAt,
        envContent: row.encryptedEnvPayload
          ? decryptEnvContent({
              workspaceId: input.workspaceId,
              repositoryExternalId: row.repositoryExternalId,
              encryptedEnvPayload: row.encryptedEnvPayload,
              encryptionKeyVersion: row.encryptionKeyVersion,
            })
          : null,
      });
    } catch (error) {
      if (error instanceof EncryptionKeyConfigError) throw error;
      console.error("[goat] Skipping invalid repository bootstrap configuration", {
        workspaceId: input.workspaceId,
        repositoryExternalId: row.repositoryExternalId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return [...configs.values()];
}

export async function listGoatWorkspaceRepositories(input: {
  db: GoatRepoConfigDb;
  workspaceId: string;
}): Promise<GoatWorkspaceRepository[]> {
  const rows = await input.db
    .select({
      repositoryExternalId: goatIntegrationResources.externalId,
      repositoryFullName: goatIntegrationResources.name,
      metadata: goatIntegrationResources.metadata,
    })
    .from(goatIntegrationResources)
    .innerJoin(goatIntegrations, eq(goatIntegrationResources.integrationId, goatIntegrations.id))
    .where(
      and(
        eq(goatIntegrations.workspaceId, input.workspaceId),
        eq(goatIntegrations.provider, "github"),
        eq(goatIntegrations.status, "connected"),
        eq(goatIntegrationResources.provider, "github"),
        eq(goatIntegrationResources.resourceType, "repository"),
        eq(goatIntegrationResources.status, "available"),
      ),
    )
    .orderBy(asc(goatIntegrationResources.name));

  const repositories = new Map<string, GoatWorkspaceRepository>();
  for (const row of rows) {
    if (!isValidGitHubRepositoryExternalId(row.repositoryExternalId)) continue;
    if (!isValidGitHubRepositoryFullName(row.repositoryFullName)) continue;
    const metadata =
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : {};
    repositories.set(row.repositoryExternalId, {
      repositoryExternalId: row.repositoryExternalId,
      repositoryFullName: row.repositoryFullName,
      private: metadata.private === true,
    });
  }
  return [...repositories.values()].toSorted((a, b) =>
    a.repositoryFullName.localeCompare(b.repositoryFullName),
  );
}

export async function upsertGoatRepoConfig(input: {
  db: GoatRepoConfigDb;
  workspaceId: string;
  repositoryExternalId: string;
  repositoryFullName: string;
  createdByWorkosId: string;
  env?: { content: string } | null;
  setupInstructions?: string;
  now?: Date;
}): Promise<GoatRepoConfigView> {
  if (!isValidGitHubRepositoryExternalId(input.repositoryExternalId)) {
    throw new Error("Invalid GitHub repository id.");
  }
  if (!isValidGitHubRepositoryFullName(input.repositoryFullName)) {
    throw new Error("Invalid GitHub repository name.");
  }
  if (input.env === undefined && input.setupInstructions === undefined) {
    throw new Error("Repository configuration update is empty.");
  }

  const now = input.now ?? new Date();
  const envColumns =
    input.env === undefined
      ? undefined
      : input.env === null
        ? {
            encryptedEnvPayload: null,
            encryptionKeyVersion: null,
            envKeys: [] as string[],
          }
        : {
            encryptedEnvPayload: encryptEnvContent({
              workspaceId: input.workspaceId,
              repositoryExternalId: input.repositoryExternalId,
              envContent: input.env.content,
              keyVersion: REPO_CONFIG_ENCRYPTION_KEY_VERSION,
            }),
            encryptionKeyVersion: REPO_CONFIG_ENCRYPTION_KEY_VERSION,
            envKeys: sanitizeEnvKeys(Object.keys(parse(input.env.content))),
          };

  const [config] = await input.db
    .insert(goatRepoConfigs)
    .values({
      id: `goat_repo_config_${randomUUID()}`,
      workspaceId: input.workspaceId,
      repositoryExternalId: input.repositoryExternalId,
      repositoryFullName: input.repositoryFullName,
      encryptedEnvPayload: envColumns?.encryptedEnvPayload ?? null,
      encryptionKeyVersion: envColumns?.encryptionKeyVersion ?? null,
      envKeys: envColumns?.envKeys ?? [],
      setupInstructions: input.setupInstructions ?? "",
      createdByWorkosId: input.createdByWorkosId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goatRepoConfigs.workspaceId, goatRepoConfigs.repositoryExternalId],
      set: {
        repositoryFullName: input.repositoryFullName,
        ...(envColumns ?? {}),
        ...(input.setupInstructions !== undefined
          ? { setupInstructions: input.setupInstructions }
          : {}),
        updatedAt: now,
      },
    })
    .returning({
      repositoryExternalId: goatRepoConfigs.repositoryExternalId,
      repositoryFullName: goatRepoConfigs.repositoryFullName,
      envKeys: goatRepoConfigs.envKeys,
      setupInstructions: goatRepoConfigs.setupInstructions,
      updatedAt: goatRepoConfigs.updatedAt,
    });

  if (!config) throw new Error("Could not persist repository configuration.");
  return {
    repositoryExternalId: config.repositoryExternalId,
    repositoryFullName: config.repositoryFullName,
    envKeys: sanitizeEnvKeys(config.envKeys),
    setupInstructions: config.setupInstructions,
    updatedAt: config.updatedAt,
  };
}

export async function deleteGoatRepoConfig(input: {
  db: GoatRepoConfigDb;
  workspaceId: string;
  repositoryExternalId: string;
}): Promise<boolean> {
  const rows = await input.db
    .delete(goatRepoConfigs)
    .where(
      and(
        eq(goatRepoConfigs.workspaceId, input.workspaceId),
        eq(goatRepoConfigs.repositoryExternalId, input.repositoryExternalId),
      ),
    )
    .returning({ id: goatRepoConfigs.id });
  return rows.length > 0;
}

function encryptEnvContent(input: {
  workspaceId: string;
  repositoryExternalId: string;
  envContent: string;
  keyVersion: number;
}): EncryptedPayload {
  return encryptJson(
    { content: input.envContent },
    {
      key: loadEncryptionKey(input.keyVersion),
      aad: authenticatedData(input, input.keyVersion),
    },
  );
}

function decryptEnvContent(input: {
  workspaceId: string;
  repositoryExternalId: string;
  encryptedEnvPayload: EncryptedPayload;
  encryptionKeyVersion: number | null;
}): string {
  if (input.encryptionKeyVersion === null) {
    throw new Error("Repository environment encryption key version is missing.");
  }
  if (input.encryptedEnvPayload.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported repository environment encryption algorithm ${input.encryptedEnvPayload.algorithm}.`,
    );
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(input.encryptionKeyVersion);
  } catch (error) {
    if (error instanceof UnsupportedKeyVersionError) {
      throw new Error(
        `Unsupported repository environment encryption key version ${input.encryptionKeyVersion}.`,
      );
    }
    throw error;
  }

  try {
    const decrypted = decryptJson(input.encryptedEnvPayload, {
      key,
      aad: authenticatedData(input, input.encryptionKeyVersion),
    });
    if (typeof decrypted.content !== "string") throw new Error("Invalid content.");
    return decrypted.content;
  } catch {
    throw new Error("Repository environment could not be decrypted.");
  }
}

function authenticatedData(
  context: { workspaceId: string; repositoryExternalId: string },
  keyVersion: number,
) {
  return buildAad({
    workspaceId: context.workspaceId,
    repositoryExternalId: context.repositoryExternalId,
    kind: "goat_repo_config_env",
    keyVersion,
  });
}

function sanitizeEnvKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (key): key is string =>
          typeof key === "string" && key.length > 0 && key.length <= 256 && /^[\w.-]+$/.test(key),
      ),
    ),
  ].slice(0, 512);
}
