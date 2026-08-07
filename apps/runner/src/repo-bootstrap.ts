import { createHash } from "node:crypto";
import { shellQuote } from "@opencompany/agent-runtime";
import {
  type DecryptedGoatRepoConfig,
  isValidGitHubRepositoryExternalId,
  listDecryptedGoatRepoConfigs,
} from "@opencompany/db/repo-configs";
import { getGoatWorkspaceRole } from "@opencompany/db/workspaces";
import { parse } from "dotenv";
import { getDb } from "./db";
import type { SandboxHandle } from "./sandbox";

export const GOAT_REPO_CONFIG_ROOT = "/opt/oc/repos";
const GOAT_REPO_CONFIG_FINGERPRINT_PATH = `${GOAT_REPO_CONFIG_ROOT}/.fingerprint`;
const SECRET_LIKE_ENV_KEY = /(secret|token|key|passw|pwd|credential|auth|cert|private|dsn|salt)/i;

export type GoatRepositoryBootstrap = {
  configs: DecryptedGoatRepoConfig[];
  promptFragment: string;
  secretValues: string[];
};

export async function loadGoatRepositoryBootstrap(
  workspaceId: string | null,
  userWorkosId: string,
): Promise<GoatRepositoryBootstrap> {
  if (!workspaceId) {
    return emptyRepositoryBootstrap();
  }

  const db = getDb();
  const role = await getGoatWorkspaceRole({ userWorkosId, workspaceId }, { db });
  if (role === null) {
    console.error("[goat] Repository bootstrap denied for non-member", {
      workspaceId,
      userWorkosId,
    });
    return emptyRepositoryBootstrap();
  }

  const configs = await listDecryptedGoatRepoConfigs({
    db,
    workspaceId,
  });
  return {
    configs,
    promptFragment: buildGoatRepositoryBootstrapPrompt(configs),
    secretValues: repositoryBootstrapSecretValues(configs),
  };
}

export async function stageGoatRepositoryBootstrap(input: {
  sandbox: SandboxHandle;
  bootstrap: GoatRepositoryBootstrap;
}) {
  const envConfigs = input.bootstrap.configs.filter(
    (config): config is DecryptedGoatRepoConfig & { envContent: string } =>
      config.envContent !== null,
  );
  const directories = envConfigs.map((config) =>
    repositoryConfigDirectory(config.repositoryExternalId),
  );
  const fingerprint = repositoryBootstrapFingerprint(input.bootstrap.configs);
  const reconcileCommands = [
    `find ${shellQuote(GOAT_REPO_CONFIG_ROOT)} -mindepth 1 -maxdepth 2 -type f -name .env -delete`,
    `find ${shellQuote(GOAT_REPO_CONFIG_ROOT)} -mindepth 1 -maxdepth 1 -type d -empty -delete`,
    ...directories.map((directory) => `install -d -m 700 -o user -g user ${shellQuote(directory)}`),
  ].join(" &&\n  ");

  const reconcile = await input.sandbox.commands.run(
    `${`install -d -m 700 -o user -g user ${shellQuote(GOAT_REPO_CONFIG_ROOT)}`} &&
if [ "$(cat ${shellQuote(GOAT_REPO_CONFIG_FINGERPRINT_PATH)} 2>/dev/null)" = ${shellQuote(fingerprint)} ]; then
  echo UNCHANGED
else
  ${reconcileCommands} &&
  echo CHANGED
fi`,
    { user: "root", timeoutMs: 30_000 },
  );

  if (reconcile.stdout.trim().endsWith("UNCHANGED")) return;

  if (envConfigs.length === 0) {
    await input.sandbox.files.write(GOAT_REPO_CONFIG_FINGERPRINT_PATH, fingerprint, {
      user: "user",
    });
    return;
  }
  await input.sandbox.files.write(
    envConfigs.map((config) => ({
      path: `${repositoryConfigDirectory(config.repositoryExternalId)}/.env`,
      data: config.envContent,
    })),
    { user: "user" },
  );
  await input.sandbox.commands.run(
    `chmod 600 ${envConfigs
      .map((config) => shellQuote(`${repositoryConfigDirectory(config.repositoryExternalId)}/.env`))
      .join(" ")}`,
    { user: "user", timeoutMs: 30_000 },
  );
  await input.sandbox.files.write(GOAT_REPO_CONFIG_FINGERPRINT_PATH, fingerprint, {
    user: "user",
  });
}

export function buildGoatRepositoryBootstrapPrompt(
  configs: readonly DecryptedGoatRepoConfig[],
): string {
  const lines = configs.flatMap((config) => {
    const envPath =
      config.envContent === null
        ? null
        : `${repositoryConfigDirectory(config.repositoryExternalId)}/.env`;
    const setupInstructions = config.setupInstructions.trim();
    if (!envPath && !setupInstructions) return [];

    const details = [
      envPath ? `its environment file is staged at ${promptJson(envPath)}` : null,
      setupInstructions
        ? `after cloning, follow the workspace's setup instructions: ${promptJson(setupInstructions)}`
        : null,
    ].filter((detail): detail is string => detail !== null);
    return [`When working on ${promptJson(config.repositoryFullName)}: ${details.join("; ")}.`];
  });
  if (lines.length === 0) return "";

  return [
    "<repository_bootstrap>",
    ...lines,
    "After cloning a repository, read and follow its root AGENTS.md and CLAUDE.md files when present, before running setup or development commands.",
    "Never print, log, summarize, or expose a staged environment file or any of its values.",
    "</repository_bootstrap>",
  ].join("\n");
}

export function repositoryConfigDirectory(repositoryExternalId: string): string {
  if (!isValidGitHubRepositoryExternalId(repositoryExternalId)) {
    throw new Error("Invalid repository configuration path.");
  }
  return `${GOAT_REPO_CONFIG_ROOT}/${repositoryExternalId}`;
}

function repositoryBootstrapSecretValues(configs: readonly DecryptedGoatRepoConfig[]): string[] {
  const values = new Set<string>();
  for (const config of configs) {
    if (config.envContent === null) continue;
    values.add(config.envContent);
    for (const [key, value] of Object.entries(parse(config.envContent))) {
      // Short values under generic names are intentionally not redacted individually: masking
      // values such as "production" or "localhost" corrupts otherwise harmless transcripts.
      if (value && (SECRET_LIKE_ENV_KEY.test(key) || value.length >= 24)) {
        values.add(value);
      }
    }
  }
  return [...values];
}

function repositoryBootstrapFingerprint(configs: readonly DecryptedGoatRepoConfig[]): string {
  const fingerprintInput = configs
    .map((config) => [
      config.repositoryExternalId,
      config.repositoryFullName,
      config.updatedAt.toISOString(),
      config.envContent !== null,
    ])
    .toSorted(([repositoryA], [repositoryB]) =>
      String(repositoryA).localeCompare(String(repositoryB)),
    );
  return createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
}

function emptyRepositoryBootstrap(): GoatRepositoryBootstrap {
  return { configs: [], promptFragment: "", secretValues: [] };
}

function promptJson(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}
