import { shellQuote } from "@opencompany/agent-runtime";
import { goatIntegrationResources, goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq, ne } from "drizzle-orm";
import {
  buildGitHubCommandEnv,
  createKnownSecretRedactor,
  formatDiffStat,
  GITHUB_AUTH_HEADER_ENV,
  gitAuthExtraHeaderArg,
  gitAuthHeader,
  githubRemoteUrl,
  isRecord,
  normalizeCommitMessage,
  readCurrentGitBranch,
  readLocalCommitCount,
  readPullRequestUrlForBranch,
  selectPublishBranch,
  truncateText,
} from "./coding-agent-shared";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { createDraftPullRequest, getGitHubWorkInstallationToken } from "./github";
import {
  cloneGitHubRepositoryIntoWorkdir,
  commandExitResult,
  createOrConnectSandbox,
  killSandbox,
  type SandboxHandle,
} from "./sandbox";

export type GoatGitHubToolName =
  | "github_clone_repository"
  | "github_shell"
  | "github_status"
  | "github_open_pull_request";

export type GoatGitHubSandboxUsage = {
  messageId?: string | null;
  sandboxId: string;
  template: string | null;
  vcpu: number | null;
  ramMib: number | null;
  startedAt: Date;
  endedAt: Date;
  activeMs: number;
  rawMetrics?: Record<string, unknown>;
};

type GoatGitHubRepositoryAccess = {
  integrationId: string;
  installationId: string;
  repositoryFullName: string;
  defaultBranch: string;
  private: boolean;
};

type GoatGitHubToolSessionState = {
  sandbox: SandboxHandle;
  sandboxStartedAt: Date;
  workdir: string;
  repository: GoatGitHubRepositoryAccess;
  githubToken: string;
  githubAuthHeader: string;
  redact: (value: string) => string;
  lastMessageId: string | null;
};

const GITHUB_PROVIDER = "github" as const;
const GITHUB_RESOURCE_TYPE = "repository";
const GOAT_GITHUB_WORKDIR = "/home/user/opencompany-goat/github";
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;

export function isGoatGitHubToolName(name: string): name is GoatGitHubToolName {
  return (
    name === "github_clone_repository" ||
    name === "github_shell" ||
    name === "github_status" ||
    name === "github_open_pull_request"
  );
}

export function createGoatGitHubToolSession(input: {
  userWorkosId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  recordSandboxUsage?: (usage: GoatGitHubSandboxUsage) => Promise<void>;
}) {
  let state: GoatGitHubToolSessionState | null = null;
  let cleanupStarted = false;

  return {
    async execute(args: {
      name: GoatGitHubToolName;
      toolInput: unknown;
      toolCallId: string;
      messageId?: string | null;
    }) {
      if (args.name === "github_clone_repository") {
        state = await cloneRepository({
          userWorkosId: input.userWorkosId,
          env: input.env,
          signal: input.signal,
          args: args.toolInput,
          toolCallId: args.toolCallId,
          messageId: args.messageId ?? null,
        });
        return cloneOutput(state);
      }

      const active = requireClonedRepository(state);
      active.lastMessageId = args.messageId ?? active.lastMessageId;
      if (args.name === "github_shell") return runShell(active, args.toolInput, input.signal);
      if (args.name === "github_status") return repositoryStatus(active);
      return openPullRequest(active, args.toolInput, args.toolCallId);
    },

    async cleanup() {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (!state) return;
      const endedAt = new Date();
      await input
        .recordSandboxUsage?.({
          messageId: state.lastMessageId,
          sandboxId: state.sandbox.sandboxId,
          template: input.env.e2bTemplate ?? null,
          vcpu: null,
          ramMib: null,
          startedAt: state.sandboxStartedAt,
          endedAt,
          activeMs: Math.max(0, endedAt.getTime() - state.sandboxStartedAt.getTime()),
          rawMetrics: {
            repository: state.repository.repositoryFullName,
          },
        })
        .catch(() => {});
      await killSandbox(state.sandbox.sandboxId).catch(() => {});
      state = null;
    },
  };
}

async function cloneRepository(input: {
  userWorkosId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  args: unknown;
  toolCallId: string;
  messageId: string | null;
}): Promise<GoatGitHubToolSessionState> {
  const args = asRecord(input.args);
  const repositoryArg = readString(args, "repository");
  const repositoryFullName = normalizeRepositoryFullName(repositoryArg);
  if (!repositoryFullName) {
    throw new Error('github_clone_repository requires repository as "owner/repo".');
  }

  const repository = await resolveRepositoryAccess({
    userWorkosId: input.userWorkosId,
    repositoryFullName,
  });
  const githubToken = await getGitHubWorkInstallationToken({
    installationId: repository.installationId,
    repositoryFullName,
  });
  if (!githubToken) {
    throw new Error("GitHub App credentials are required for Goat GitHub tools.");
  }
  const githubAuthHeader = gitAuthHeader(githubToken);
  const redact = createKnownSecretRedactor([githubToken, githubAuthHeader]);
  const sandboxStartedAt = new Date();
  const sandbox = await createOrConnectSandbox({
    template: input.env.e2bTemplate,
    envs: {},
    idleTimeoutMs: input.env.e2bSandboxIdleTimeoutMs,
  });
  const workdir = GOAT_GITHUB_WORKDIR;
  await sandbox.commands.run(`mkdir -p ${shellQuote(parentDir(workdir))}`, { timeoutMs: 30_000 });
  await cloneGitHubRepositoryIntoWorkdir({
    sandbox,
    workdir,
    repositoryFullName,
    defaultBranch: repository.defaultBranch,
    githubToken,
  });

  const ref = readString(args, "ref");
  if (ref) {
    await sandbox.commands.run(
      `cd ${shellQuote(workdir)} && git ${gitAuthExtraHeaderArg()} fetch --depth 1 origin ${shellQuote(
        ref,
      )} && git checkout --detach FETCH_HEAD`,
      {
        envs: { [GITHUB_AUTH_HEADER_ENV]: githubAuthHeader },
        timeoutMs: 120_000,
      },
    );
  }

  await sandbox.commands.run(
    [
      `cd ${shellQuote(workdir)}`,
      `git config user.name ${shellQuote("OpenCompany Goat")}`,
      `git config user.email ${shellQuote("goat@opencompany.ai")}`,
      `git remote set-url origin ${shellQuote(githubRemoteUrl(repositoryFullName))}`,
    ].join(" && "),
    { timeoutMs: 30_000 },
  );

  return {
    sandbox,
    sandboxStartedAt,
    workdir,
    repository,
    githubToken,
    githubAuthHeader,
    redact,
    lastMessageId: input.messageId,
  };
}

async function resolveRepositoryAccess(input: {
  userWorkosId: string;
  repositoryFullName: string;
}): Promise<GoatGitHubRepositoryAccess> {
  const [row] = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      installationId: goatIntegrations.externalId,
      integrationStatus: goatIntegrations.status,
      resourceStatus: goatIntegrationResources.status,
      name: goatIntegrationResources.name,
      metadata: goatIntegrationResources.metadata,
    })
    .from(goatIntegrationResources)
    .innerJoin(
      goatIntegrations,
      and(
        eq(goatIntegrationResources.integrationId, goatIntegrations.id),
        eq(goatIntegrationResources.userWorkosId, goatIntegrations.userWorkosId),
        eq(goatIntegrationResources.provider, goatIntegrations.provider),
      ),
    )
    .where(
      and(
        eq(goatIntegrationResources.userWorkosId, input.userWorkosId),
        eq(goatIntegrationResources.provider, GITHUB_PROVIDER),
        eq(goatIntegrationResources.resourceType, GITHUB_RESOURCE_TYPE),
        eq(goatIntegrationResources.name, input.repositoryFullName),
        eq(goatIntegrations.provider, GITHUB_PROVIDER),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .limit(1);

  if (!row || row.integrationStatus !== "connected" || row.resourceStatus !== "available") {
    throw new Error(
      `Connect GitHub in Settings and grant access to ${input.repositoryFullName} before using GitHub tools.`,
    );
  }

  return {
    integrationId: row.integrationId,
    installationId: row.installationId,
    repositoryFullName: row.name,
    defaultBranch: readMetadataString(row.metadata, "defaultBranch") || "main",
    private: readMetadataBoolean(row.metadata, "private") ?? true,
  };
}

async function runShell(
  state: GoatGitHubToolSessionState,
  argsValue: unknown,
  signal: AbortSignal,
) {
  const args = asRecord(argsValue);
  const command = readString(args, "command");
  if (!command) throw new Error("github_shell requires a command.");
  assertNotAborted(signal);

  const timeoutMs = clampTimeout(readNumber(args, "timeoutMs"));
  let result: { stdout?: unknown; stderr?: unknown; exitCode?: number | null };
  try {
    result = await state.sandbox.commands.run(`cd ${shellQuote(state.workdir)} && ${command}`, {
      envs: commandEnv(state),
      timeoutMs,
    });
  } catch (error) {
    const exitResult = commandExitResult(error);
    if (!exitResult) throw error;
    result = exitResult;
  }

  return {
    ok: result.exitCode === 0,
    repository: state.repository.repositoryFullName,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
    stdout: truncateText(state.redact(String(result.stdout ?? "")), 20_000),
    stderr: truncateText(state.redact(String(result.stderr ?? "")), 12_000),
  };
}

async function repositoryStatus(state: GoatGitHubToolSessionState) {
  const [branch, status, stat, diff] = await Promise.all([
    readCurrentGitBranch(state.sandbox, state.workdir),
    state.sandbox.commands.run(`cd ${shellQuote(state.workdir)} && git status --short`, {
      timeoutMs: 30_000,
    }),
    state.sandbox.commands.run(`cd ${shellQuote(state.workdir)} && git diff HEAD --stat`, {
      timeoutMs: 30_000,
    }),
    state.sandbox.commands.run(`cd ${shellQuote(state.workdir)} && git diff HEAD | head -400`, {
      timeoutMs: 30_000,
    }),
  ]);

  return {
    ok: true,
    repository: state.repository.repositoryFullName,
    branch,
    status: truncateText(state.redact(String(status.stdout ?? "")), 8_000),
    diffStat: truncateText(state.redact(formatDiffStat(stat.stdout, status.stdout)), 8_000),
    diffPreview: truncateText(state.redact(String(diff.stdout ?? "")), 24_000),
  };
}

async function openPullRequest(
  state: GoatGitHubToolSessionState,
  argsValue: unknown,
  toolCallId: string,
) {
  const args = asRecord(argsValue);
  const title = normalizeCommitMessage(readString(args, "title"), "Apply Goat changes");
  const commitMessage = normalizeCommitMessage(readString(args, "commitMessage") || title, title);
  const body = readString(args, "body") || "Created by OpenCompany Goat.";
  const currentBranch = await readCurrentGitBranch(state.sandbox, state.workdir);
  const defaultBranch = state.repository.defaultBranch;
  const branchName =
    normalizeBranchName(readString(args, "branchName")) ??
    selectPublishBranch({
      currentBranch,
      defaultBranch,
      sessionId: toolCallId,
      now: Date.now(),
      prefix: "goat",
    });

  const existingPrUrl =
    branchName === currentBranch
      ? await readPullRequestUrlForBranch(
          state.sandbox,
          state.workdir,
          currentBranch,
          commandEnv(state),
        )
      : null;
  if (existingPrUrl) {
    return {
      ok: true,
      repository: state.repository.repositoryFullName,
      branchName,
      pullRequestUrl: existingPrUrl,
      created: false,
    };
  }

  const statusBefore = await state.sandbox.commands.run(
    `cd ${shellQuote(state.workdir)} && git status --short`,
    { timeoutMs: 30_000 },
  );
  const hasDiff = String(statusBefore.stdout ?? "").trim().length > 0;
  const localCommitCount = await readLocalCommitCount(state.sandbox, state.workdir, defaultBranch);

  if (!hasDiff && localCommitCount === 0) {
    throw new Error("No GitHub repository changes are available to publish.");
  }

  const prepareCommands = [
    `cd ${shellQuote(state.workdir)}`,
    ...(branchName === currentBranch ? [] : [`git checkout -B ${shellQuote(branchName)}`]),
    ...(hasDiff ? [`git add -A`, `git commit -m ${shellQuote(commitMessage)}`] : []),
    `git remote set-url origin ${shellQuote(githubRemoteUrl(state.repository.repositoryFullName))}`,
  ];
  await state.sandbox.commands.run(prepareCommands.join(" && "), { timeoutMs: 120_000 });

  await state.sandbox.commands.run(
    `cd ${shellQuote(state.workdir)} && git ${gitAuthExtraHeaderArg()} push -u origin ${shellQuote(
      branchName,
    )}`,
    {
      envs: { [GITHUB_AUTH_HEADER_ENV]: state.githubAuthHeader },
      timeoutMs: 180_000,
    },
  );

  const pr = await createDraftPullRequest({
    installationId: state.repository.installationId,
    repositoryFullName: state.repository.repositoryFullName,
    title,
    head: branchName,
    base: defaultBranch,
    body,
    draft: readBoolean(args, "draft") ?? true,
  });

  return {
    ok: true,
    repository: state.repository.repositoryFullName,
    branchName,
    pullRequestUrl: pr.html_url ?? null,
    pullRequestNumber: pr.number ?? null,
    created: true,
  };
}

function cloneOutput(state: GoatGitHubToolSessionState) {
  return {
    ok: true,
    repository: state.repository.repositoryFullName,
    defaultBranch: state.repository.defaultBranch,
    private: state.repository.private,
    workdir: state.workdir,
    sandboxId: state.sandbox.sandboxId,
  };
}

function requireClonedRepository(state: GoatGitHubToolSessionState | null) {
  if (!state) {
    throw new Error("Call github_clone_repository before using GitHub shell, status, or PR tools.");
  }
  return state;
}

function commandEnv(state: GoatGitHubToolSessionState) {
  return {
    ...buildGitHubCommandEnv({
      githubAuthHeader: state.githubAuthHeader,
      githubToken: state.githubToken,
      repositoryFullName: state.repository.repositoryFullName,
      toolCallId: `goat-${state.sandbox.sandboxId}`,
    }),
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function normalizeRepositoryFullName(value: string) {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return "";
  return trimmed;
}

function normalizeBranchName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(trimmed) || trimmed.includes("..")) return null;
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function readMetadataString(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function readMetadataBoolean(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : null;
}

function clampTimeout(value: number | null) {
  if (!value) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(value), 1_000), MAX_COMMAND_TIMEOUT_MS);
}

function parentDir(value: string) {
  return value.split("/").slice(0, -1).join("/") || "/";
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Goat GitHub tool was aborted.");
}
