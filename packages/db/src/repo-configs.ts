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
import type * as schema from "./product-schema";
import { integrationResources, integrations, repoConfigs } from "./product-schema";

const REPO_CONFIG_ENCRYPTION_KEY_VERSION = DEFAULT_ENCRYPTION_KEY_VERSION;

type DbSchema = typeof schema;
export type RepoConfigDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "delete" | "insert" | "select" | "update"
>;

export type RepoConfigView = {
  repositoryExternalId: string;
  repositoryFullName: string;
  envKeys: string[];
  setupInstructions: string;
  updatedAt: Date;
};

export type DecryptedRepoConfig = RepoConfigView & {
  envContent: string | null;
};

export type WorkspaceRepository = {
  repositoryExternalId: string;
  repositoryFullName: string;
  private: boolean;
};

export function isValidGitHubRepositoryExternalId(value: string): boolean {
  return /^[1-9]\d{0,63}$/.test(value);
}

export const REPO_ENV_MAX_BYTES = 256 * 1024;
export const REPO_SETUP_INSTRUCTIONS_MAX_LENGTH = 4_000;

export type ValidatedRepoEnv = { ok: true } | { ok: false; message: string };

export function validateRepoEnv(content: string): ValidatedRepoEnv {
  if (!content.trim()) {
    return { ok: false, message: "Paste an environment file before saving." };
  }
  if (content.includes("\0")) {
    return { ok: false, message: "Environment files cannot contain null bytes." };
  }
  if (Buffer.byteLength(content, "utf8") > REPO_ENV_MAX_BYTES) {
    return {
      ok: false,
      message: `Environment files must be ${REPO_ENV_MAX_BYTES / 1024} KB or smaller.`,
    };
  }

  const keys = Object.keys(parse(content));
  if (keys.length === 0) {
    return { ok: false, message: "No environment variables were found." };
  }
  if (keys.length > 512) {
    return { ok: false, message: "Environment files can contain at most 512 variables." };
  }
  if (keys.some((key) => key.length > 256)) {
    return { ok: false, message: "Environment variable names must be 256 characters or fewer." };
  }
  return { ok: true };
}

export function normalizeRepoSetupInstructions(
  value: string,
): { ok: true; instructions: string } | { ok: false; message: string } {
  const instructions = value.trim();
  if (instructions.length > REPO_SETUP_INSTRUCTIONS_MAX_LENGTH) {
    return {
      ok: false,
      message: `Setup instructions must be ${REPO_SETUP_INSTRUCTIONS_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    };
  }
  return { ok: true, instructions };
}

export function isValidGitHubRepositoryFullName(value: string): boolean {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

export async function listRepoConfigs(input: {
  db: RepoConfigDb;
  workspaceId: string;
}): Promise<RepoConfigView[]> {
  const rows = await input.db
    .select({
      repositoryExternalId: repoConfigs.repositoryExternalId,
      repositoryFullName: repoConfigs.repositoryFullName,
      envKeys: repoConfigs.envKeys,
      setupInstructions: repoConfigs.setupInstructions,
      updatedAt: repoConfigs.updatedAt,
    })
    .from(repoConfigs)
    .where(eq(repoConfigs.workspaceId, input.workspaceId))
    .orderBy(asc(repoConfigs.repositoryFullName));

  return rows.map((row) => ({
    repositoryExternalId: row.repositoryExternalId,
    repositoryFullName: row.repositoryFullName,
    envKeys: sanitizeEnvKeys(row.envKeys),
    setupInstructions: row.setupInstructions,
    updatedAt: row.updatedAt,
  }));
}

export async function listDecryptedRepoConfigs(input: {
  db: RepoConfigDb;
  workspaceId: string;
}): Promise<DecryptedRepoConfig[]> {
  const rows = await input.db
    .select({
      workspaceId: repoConfigs.workspaceId,
      repositoryExternalId: repoConfigs.repositoryExternalId,
      repositoryFullName: integrationResources.name,
      encryptedEnvPayload: repoConfigs.encryptedEnvPayload,
      encryptionKeyVersion: repoConfigs.encryptionKeyVersion,
      envKeys: repoConfigs.envKeys,
      setupInstructions: repoConfigs.setupInstructions,
      updatedAt: repoConfigs.updatedAt,
    })
    .from(repoConfigs)
    .innerJoin(
      integrationResources,
      and(
        eq(integrationResources.externalId, repoConfigs.repositoryExternalId),
        eq(integrationResources.provider, "github"),
        eq(integrationResources.resourceType, "repository"),
        eq(integrationResources.status, "available"),
      ),
    )
    .innerJoin(
      integrations,
      and(
        eq(integrations.id, integrationResources.integrationId),
        eq(integrations.workspaceId, repoConfigs.workspaceId),
        eq(integrations.provider, "github"),
        eq(integrations.status, "connected"),
      ),
    )
    .where(eq(repoConfigs.workspaceId, input.workspaceId))
    .orderBy(asc(integrationResources.name));

  const configs = new Map<string, DecryptedRepoConfig>();
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
      console.error("[opencompany] Skipping invalid repository bootstrap configuration", {
        workspaceId: input.workspaceId,
        repositoryExternalId: row.repositoryExternalId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return [...configs.values()];
}

export async function listWorkspaceRepositories(input: {
  db: RepoConfigDb;
  workspaceId: string;
}): Promise<WorkspaceRepository[]> {
  const rows = await input.db
    .select({
      repositoryExternalId: integrationResources.externalId,
      repositoryFullName: integrationResources.name,
      metadata: integrationResources.metadata,
    })
    .from(integrationResources)
    .innerJoin(integrations, eq(integrationResources.integrationId, integrations.id))
    .where(
      and(
        eq(integrations.workspaceId, input.workspaceId),
        eq(integrations.provider, "github"),
        eq(integrations.status, "connected"),
        eq(integrationResources.provider, "github"),
        eq(integrationResources.resourceType, "repository"),
        eq(integrationResources.status, "available"),
      ),
    )
    .orderBy(asc(integrationResources.name));

  const repositories = new Map<string, WorkspaceRepository>();
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

export async function upsertRepoConfig(input: {
  db: RepoConfigDb;
  workspaceId: string;
  repositoryExternalId: string;
  repositoryFullName: string;
  createdByWorkosId: string;
  env?: { content: string } | null;
  setupInstructions?: string;
  now?: Date;
}): Promise<RepoConfigView> {
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
    .insert(repoConfigs)
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
      target: [repoConfigs.workspaceId, repoConfigs.repositoryExternalId],
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
      repositoryExternalId: repoConfigs.repositoryExternalId,
      repositoryFullName: repoConfigs.repositoryFullName,
      envKeys: repoConfigs.envKeys,
      setupInstructions: repoConfigs.setupInstructions,
      updatedAt: repoConfigs.updatedAt,
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

export async function deleteRepoConfig(input: {
  db: RepoConfigDb;
  workspaceId: string;
  repositoryExternalId: string;
}): Promise<boolean> {
  const rows = await input.db
    .delete(repoConfigs)
    .where(
      and(
        eq(repoConfigs.workspaceId, input.workspaceId),
        eq(repoConfigs.repositoryExternalId, input.repositoryExternalId),
      ),
    )
    .returning({ id: repoConfigs.id });
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
