import { shellQuote } from "@opencompany/agent-runtime";
import type { AgentGitHubRepositoryConfig } from "@opencompany/agent-runtime/types";
import type { SandboxHandle } from "./sandbox";

// Shared, self-contained helpers used by coding-agent harness tools (amp_coder,
// opencode_coder, ...). Everything here is pure or sandbox-only — no DB access —
// so a new harness can reuse the repo/PR/redaction plumbing without duplicating it.

export const GITHUB_AUTH_HEADER_ENV = "GITHUB_AUTH_HEADER";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

export function safePathSegment(value: string, fallback = "coder") {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-") || fallback;
}

export function gitAuthHeader(token: string) {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  )}`;
}

export function gitAuthExtraHeaderArg() {
  return `-c http.extraheader="$${GITHUB_AUTH_HEADER_ENV}"`;
}

export function githubRemoteUrl(repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error("Invalid GitHub repository name for push.");
  }
  return `https://github.com/${repositoryFullName}.git`;
}

export function normalizeCommitMessage(value: string, fallback: string) {
  const firstLine = value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine || fallback;
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

export function formatDiffStat(stat: unknown, status: unknown) {
  const statText = String(stat ?? "").trim();
  const statusText = String(status ?? "").trim();
  if (!statusText) return statText;
  if (!statText) return statusText;
  return `${statText}\n\n${statusText}`;
}

export function buildGitHubCommandEnv(input: {
  githubAuthHeader: string;
  githubToken: string;
  toolCallId: string;
  repositoryFullName?: string;
}) {
  return {
    GH_TOKEN: input.githubToken,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    ...(input.repositoryFullName ? { GH_REPO: input.repositoryFullName } : {}),
    GH_CONFIG_DIR: `/tmp/opencompany-gh-${safePathSegment(input.toolCallId)}`,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: input.githubAuthHeader,
  };
}

export function createKnownSecretRedactor(secrets: Array<string | null | undefined>) {
  const patterns = [...new Set(secrets.filter((secret): secret is string => Boolean(secret)))]
    .filter((secret) => secret.length >= 6)
    .sort((a, b) => b.length - a.length);

  return (value: string) => {
    let output = value;
    for (const secret of patterns) {
      output = output.split(secret).join("[redacted]");
    }
    return output;
  };
}

export function selectPublishBranch(input: {
  currentBranch: string | null;
  defaultBranch: string;
  sessionId: string;
  now: number;
  prefix: string;
}) {
  if (input.currentBranch && input.currentBranch !== input.defaultBranch) {
    return input.currentBranch;
  }
  return `opencompany/${input.prefix}-${input.sessionId.slice(-8)}-${input.now}`;
}

export function resolveCodingAgentTargetRepository(input: {
  toolName: string;
  repositories: AgentGitHubRepositoryConfig[];
  requestedRepository?: string | undefined;
}): AgentGitHubRepositoryConfig {
  const { repositories, toolName } = input;
  if (repositories.length === 0) {
    throw new Error(
      `${toolName} needs at least one GitHub repository attached to the agent. Add a repository, then try again.`,
    );
  }

  const requested = input.requestedRepository?.trim();
  if (requested) {
    const requestedLower = requested.toLowerCase();
    const match = repositories.find(
      (repository) =>
        repository.id === requested || repository.fullName.toLowerCase() === requestedLower,
    );
    if (!match) {
      throw new Error(
        `Requested repository "${requested}" is not attached to this agent. Attached repositories: ${repositories
          .map((repository) => repository.fullName)
          .join(", ")}.`,
      );
    }
    return match;
  }

  if (repositories.length === 1) return repositories[0]!;

  throw new Error(
    `More than one repository is attached. Set the repository argument (owner/repo or id) to choose one. Attached repositories: ${repositories
      .map((repository) => repository.fullName)
      .join(", ")}.`,
  );
}

export async function readCurrentGitBranch(sandbox: SandboxHandle, workRoot: string) {
  const result = await sandbox.commands.run(
    `cd ${shellQuote(workRoot)} && git branch --show-current`,
    { timeoutMs: 30_000 },
  );
  const branch = String(result.stdout ?? "").trim();
  return branch || null;
}

export async function readLocalCommitCount(
  sandbox: SandboxHandle,
  workRoot: string,
  defaultBranch: string,
) {
  const result = await sandbox.commands.run(
    `cd ${shellQuote(workRoot)} && git rev-list --count ${shellQuote(
      `origin/${defaultBranch}..HEAD`,
    )} 2>/dev/null || printf '0\\n'`,
    { timeoutMs: 30_000 },
  );
  const count = Number.parseInt(String(result.stdout ?? "").trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

export async function readPullRequestUrlForBranch(
  sandbox: SandboxHandle,
  workRoot: string,
  branch: string | null,
  envs: Record<string, string>,
) {
  if (!branch) return null;

  const result = await sandbox.commands.run(
    `cd ${shellQuote(workRoot)} && gh pr view ${shellQuote(
      branch,
    )} --json url --jq .url 2>/dev/null || true`,
    { envs, timeoutMs: 60_000 },
  );
  const url = String(result.stdout ?? "").trim();
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url)
    ? url
    : null;
}
