import { codexCliModelNameForModelId, shellQuote } from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import {
  loadGoatCodexCredential,
  markGoatCodexCredentialNeedsReauth,
  rotateGoatCodexCredential,
} from "@opencompany/db/goat-codex-auth";
import { goatIntegrationResources, goatIntegrations } from "@opencompany/db/goat-schema";
import type { LanguageModelUsage } from "ai";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  type CodexAppServerGoalSummary,
  type CodexGoalModeInput,
  runCodexAppServerTurn,
} from "./codex-app-server";
import { type CodexCliAuth, codexApiKeyFallbackEnabled, ensureCodexInstalled } from "./codex-tool";
import {
  buildGitHubCommandEnv,
  createKnownSecretRedactor,
  formatDiffStat,
  GITHUB_AUTH_HEADER_ENV,
  gitAuthExtraHeaderArg,
  gitAuthHeader,
  githubRemoteUrl,
  normalizeCommitMessage,
  readCurrentGitBranch,
  readLocalCommitCount,
  readPullRequestUrlForBranch,
  selectPublishBranch,
  truncateText,
} from "./coding-agent-shared";
import { getDb } from "./db";
import { brokerActive, brokerBaseUrl, type RunnerEnv } from "./env";
import { createDraftPullRequest, getGitHubWorkInstallationToken } from "./github";
import { withBrokerDelegation } from "./llm-broker-tokens";
import {
  cloneGitHubRepositoryIntoWorkdir,
  createOrConnectSandbox,
  killSandbox,
  type SandboxHandle,
} from "./sandbox";

const CODEX_HOME = "/home/user/.opencompany-goat/codex-home";
const CODEX_WORKDIR = "/home/user/opencompany-goat/codex";
const GOAT_CODEX_SKILL_FINGERPRINT = "goat-codex-v1";
const CODEX_DIRECT_BASE_URL = "https://api.openai.com/v1";
const CODEX_DIRECT_API_KEY_ENV_VAR = "CODEX_API_KEY";
const BROKER_TOKEN_ENV_VAR = "OPENCOMPANY_LLM_BROKER_TOKEN";

type GoatCodexRepositoryAccess = {
  integrationId: string;
  installationId: string;
  repositoryFullName: string;
  defaultBranch: string;
};

export type GoatCodexRunResult = {
  content: string;
  sandboxId: string;
  sandboxStartedAt: Date;
  sandboxEndedAt: Date;
  model: string;
  goal?: CodexAppServerGoalSummary | null;
  usage?: LanguageModelUsage;
};

export async function runGoatCodexTask(input: {
  userWorkosId: string;
  taskId: string;
  messageId: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  existingEngineSessionId?: string | null;
  repository?: string | null;
  createPullRequest?: boolean;
  reasoningEffort?: CodexReasoningEffort;
  goalMode?: CodexGoalModeInput | null;
  env: RunnerEnv;
  signal: AbortSignal;
  onEngineSessionId?: (engineSessionId: string) => Promise<void>;
  onRuntimeEvents?: (events: Record<string, unknown>[]) => Promise<void>;
  onOutput?: (delta: string) => Promise<void>;
}): Promise<GoatCodexRunResult> {
  assertNotAborted(input.signal);
  const model = codexCliModelNameForModelId(input.model) ?? input.env.codexModel;
  const repository = input.repository?.trim()
    ? await resolveRepositoryAccess({
        userWorkosId: input.userWorkosId,
        repositoryFullName: normalizeRepositoryFullName(input.repository),
      })
    : null;
  const sandboxStartedAt = new Date();
  const sandbox = await createOrConnectSandbox({
    template: input.env.codexE2bTemplate ?? "codex",
    envs: {},
    idleTimeoutMs: input.env.e2bSandboxIdleTimeoutMs,
  });

  try {
    const summary = await runGoatCodexWithAuth({
      ...input,
      sandbox,
      model,
      repository,
    });
    const sandboxEndedAt = new Date();
    return {
      ...summary,
      sandboxId: sandbox.sandboxId,
      sandboxStartedAt,
      sandboxEndedAt,
      model,
    };
  } finally {
    await killSandbox(sandbox.sandboxId).catch(() => {});
  }
}

async function runGoatCodexWithAuth(input: {
  userWorkosId: string;
  taskId: string;
  messageId: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  existingEngineSessionId?: string | null;
  repository: GoatCodexRepositoryAccess | null;
  createPullRequest?: boolean;
  reasoningEffort?: CodexReasoningEffort;
  goalMode?: CodexGoalModeInput | null;
  env: RunnerEnv;
  signal: AbortSignal;
  sandbox: SandboxHandle;
  onEngineSessionId?: (engineSessionId: string) => Promise<void>;
  onRuntimeEvents?: (events: Record<string, unknown>[]) => Promise<void>;
  onOutput?: (delta: string) => Promise<void>;
}): Promise<{
  content: string;
  goal?: CodexAppServerGoalSummary | null;
  usage?: LanguageModelUsage;
}> {
  const runWithAuth = async (auth: CodexCliAuth) => runGoatCodexCommand({ ...input, auth });
  const goatAuth = await loadGoatCodexCliAuth(input.userWorkosId);
  if (goatAuth) return runWithAuth(goatAuth);

  if (!codexApiKeyFallbackEnabled()) {
    throw new Error("Connect Codex in Goat settings before running Codex tasks.");
  }

  if (brokerActive(input.env) && input.env.publicUrl) {
    return withBrokerDelegation(
      {
        sessionId: input.taskId,
        workspaceId: input.userWorkosId,
        messageId: input.messageId,
        toolCallId: "goat-codex",
        toolName: "goat_codex",
        provider: "openai",
        ttlMs: input.env.codexTimeoutMs + 10 * 60 * 1000,
      },
      (minted) =>
        runWithAuth({
          kind: "api",
          baseUrl: brokerBaseUrl(input.env.publicUrl as string, "openai"),
          apiKeyEnvVar: BROKER_TOKEN_ENV_VAR,
          apiKeyValue: minted.token,
          brokered: true,
        }),
    );
  }

  if (!input.env.openaiCodexApiKey) {
    throw new Error("OPENAI_CODEX_API_KEY is required to run Codex tasks.");
  }

  return runWithAuth({
    kind: "api",
    baseUrl: CODEX_DIRECT_BASE_URL,
    apiKeyEnvVar: CODEX_DIRECT_API_KEY_ENV_VAR,
    apiKeyValue: input.env.openaiCodexApiKey,
    brokered: false,
  });
}

async function runGoatCodexCommand(input: {
  userWorkosId: string;
  taskId: string;
  messageId: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  existingEngineSessionId?: string | null;
  repository: GoatCodexRepositoryAccess | null;
  createPullRequest?: boolean;
  reasoningEffort?: CodexReasoningEffort;
  goalMode?: CodexGoalModeInput | null;
  env: RunnerEnv;
  signal: AbortSignal;
  sandbox: SandboxHandle;
  auth: CodexCliAuth;
  onEngineSessionId?: (engineSessionId: string) => Promise<void>;
  onRuntimeEvents?: (events: Record<string, unknown>[]) => Promise<void>;
  onOutput?: (delta: string) => Promise<void>;
}): Promise<{
  content: string;
  goal?: CodexAppServerGoalSummary | null;
  usage?: LanguageModelUsage;
}> {
  const serializedAuthJson =
    input.auth.kind === "chatgpt" ? JSON.stringify(input.auth.authJson) : null;
  let githubToken: string | null = null;
  let githubAuthHeader: string | null = null;

  await input.sandbox.commands.run(
    `mkdir -p ${shellQuote(CODEX_WORKDIR)} ${shellQuote(CODEX_HOME)}`,
    {
      timeoutMs: 30_000,
    },
  );
  if (serializedAuthJson) {
    await input.sandbox.files.write(`${CODEX_HOME}/auth.json`, serializedAuthJson);
  }
  await ensureCodexInstalled(input.sandbox);

  if (input.repository) {
    githubToken = await getGitHubWorkInstallationToken({
      installationId: input.repository.installationId,
      repositoryFullName: input.repository.repositoryFullName,
    });
    if (!githubToken) throw new Error("GitHub App credentials are required for Goat Codex.");
    githubAuthHeader = gitAuthHeader(githubToken);
    await cloneGitHubRepositoryIntoWorkdir({
      sandbox: input.sandbox,
      workdir: CODEX_WORKDIR,
      repositoryFullName: input.repository.repositoryFullName,
      defaultBranch: input.repository.defaultBranch,
      githubToken,
    });
    await input.sandbox.commands.run(
      [
        `cd ${shellQuote(CODEX_WORKDIR)}`,
        `git config user.name ${shellQuote("OpenCompany Goat")}`,
        `git config user.email ${shellQuote("goat@opencompany.ai")}`,
        `git remote set-url origin ${shellQuote(githubRemoteUrl(input.repository.repositoryFullName))}`,
      ].join(" && "),
      { timeoutMs: 30_000 },
    );
  }

  const redact = createKnownSecretRedactor([
    input.auth.kind === "api" ? input.auth.apiKeyValue : null,
    serializedAuthJson,
    githubToken,
    githubAuthHeader,
  ]);

  const task = buildCodexTask(input);
  const envs = {
    CODEX_HOME,
    ...(input.auth.kind === "api" ? { [input.auth.apiKeyEnvVar]: input.auth.apiKeyValue } : {}),
    ...(input.repository && githubToken && githubAuthHeader
      ? buildGitHubCommandEnv({
          githubAuthHeader,
          githubToken,
          repositoryFullName: input.repository.repositoryFullName,
          toolCallId: "goat-codex",
        })
      : {}),
  };

  const summary = await runCodexAppServerTurn({
    sandbox: input.sandbox,
    codexWorkRoot: CODEX_WORKDIR,
    codexHome: CODEX_HOME,
    skillFingerprint: GOAT_CODEX_SKILL_FINGERPRINT,
    task,
    model: input.model,
    reasoningEffort: input.reasoningEffort ?? "high",
    planModeReasoningEffort: null,
    goalMode: input.goalMode ?? null,
    existingEngineSessionId: input.existingEngineSessionId ?? null,
    auth: input.auth,
    githubAuth: { githubToken, githubAuthHeader },
    timeoutMs: input.env.codexTimeoutMs,
    checkAbort: async () => {
      assertNotAborted(input.signal);
    },
    onRuntimeEvents: input.onRuntimeEvents ?? (async () => undefined),
    onActivity: async (activity) => {
      await input.onOutput?.(redact(activity));
    },
  });
  if (summary.sessionId) {
    await input.onEngineSessionId?.(summary.sessionId);
  }
  await persistRefreshedGoatCodexAuth({
    sandbox: input.sandbox,
    userWorkosId: input.userWorkosId,
    auth: input.auth,
  });

  const diff = input.repository
    ? await collectGitDiffSummary({
        sandbox: input.sandbox,
        repository: input.repository,
        githubAuthHeader,
        createPullRequest: input.createPullRequest === true,
        task,
        envs,
        redact,
      })
    : null;
  const content = formatCodexResult({
    result: redact(summary.result),
    error: summary.error ? redact(summary.error) : null,
    status: summary.status,
    goal: summary.goal,
    repositoryFullName: input.repository?.repositoryFullName ?? null,
    diffStat: diff?.diffStat ?? null,
    diffPreview: diff?.diffPreview ?? null,
    pullRequestUrl: diff?.pullRequestUrl ?? null,
    pullRequestSkippedReason: diff?.pullRequestSkippedReason ?? null,
  });
  return {
    content,
    goal: summary.goal,
    ...(summary.usage
      ? {
          usage: {
            inputTokens: summary.usage.input_tokens,
            outputTokens: summary.usage.output_tokens,
            totalTokens: summary.usage.input_tokens + summary.usage.output_tokens,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: summary.usage.cache_read_input_tokens,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              reasoningTokens: undefined,
              textTokens: undefined,
            },
            raw: { ...summary.usage },
          } satisfies LanguageModelUsage,
        }
      : {}),
  };
}

async function collectGitDiffSummary(input: {
  sandbox: SandboxHandle;
  repository: GoatCodexRepositoryAccess;
  githubAuthHeader: string | null;
  createPullRequest: boolean;
  task: string;
  envs: Record<string, string>;
  redact: (value: string) => string;
}) {
  await input.sandbox.commands.run(`cd ${shellQuote(CODEX_WORKDIR)} && git add -N .`, {
    timeoutMs: 60_000,
  });
  const diffStatus = await input.sandbox.commands.run(
    `cd ${shellQuote(CODEX_WORKDIR)} && git status --short`,
    { timeoutMs: 60_000 },
  );
  const diffStat = await input.sandbox.commands.run(
    `cd ${shellQuote(CODEX_WORKDIR)} && git diff HEAD --stat`,
    { timeoutMs: 60_000 },
  );
  const diffPreview = await input.sandbox.commands.run(
    `cd ${shellQuote(CODEX_WORKDIR)} && git diff HEAD | head -400`,
    { timeoutMs: 60_000 },
  );
  const hasDiff = String(diffStatus.stdout ?? "").trim().length > 0;
  const currentBranch = await readCurrentGitBranch(input.sandbox, CODEX_WORKDIR);
  const localCommitCount = await readLocalCommitCount(
    input.sandbox,
    CODEX_WORKDIR,
    input.repository.defaultBranch,
  );
  let pullRequestUrl: string | null = null;
  let pullRequestSkippedReason: string | null = null;

  if (input.createPullRequest && !hasDiff && localCommitCount === 0) {
    pullRequestSkippedReason = "no_changes";
  } else if (input.createPullRequest && input.githubAuthHeader) {
    const existingPrUrl = await readPullRequestUrlForBranch(
      input.sandbox,
      CODEX_WORKDIR,
      currentBranch,
      input.envs,
    );
    if (existingPrUrl) {
      pullRequestUrl = existingPrUrl;
    } else {
      const branchName = selectPublishBranch({
        currentBranch,
        defaultBranch: input.repository.defaultBranch,
        sessionId: input.repository.integrationId,
        now: Date.now(),
        prefix: "goat-codex",
      });
      const commitMessage = normalizeCommitMessage(input.task, "Apply Codex changes");
      const prepareCommands = [
        `cd ${shellQuote(CODEX_WORKDIR)}`,
        ...(branchName === currentBranch ? [] : [`git checkout -b ${shellQuote(branchName)}`]),
        ...(hasDiff ? [`git add -A .`, `git commit -m ${shellQuote(commitMessage)}`] : []),
        `git remote set-url origin ${shellQuote(githubRemoteUrl(input.repository.repositoryFullName))}`,
      ];
      await input.sandbox.commands.run(prepareCommands.join(" && "), { timeoutMs: 120_000 });
      await input.sandbox.commands.run(
        `cd ${shellQuote(CODEX_WORKDIR)} && git ${gitAuthExtraHeaderArg()} push origin ${shellQuote(branchName)}`,
        {
          envs: { [GITHUB_AUTH_HEADER_ENV]: input.githubAuthHeader },
          timeoutMs: 180_000,
        },
      );
      const pr = await createDraftPullRequest({
        installationId: input.repository.installationId,
        repositoryFullName: input.repository.repositoryFullName,
        title: commitMessage,
        head: branchName,
        base: input.repository.defaultBranch,
        body: ["Created by OpenCompany Goat Codex.", "", `Task: ${input.task}`].join("\n"),
      });
      pullRequestUrl = pr.html_url ?? null;
    }
  }

  return {
    diffStat: truncateText(input.redact(formatDiffStat(diffStat.stdout, diffStatus.stdout)), 4000),
    diffPreview: truncateText(input.redact(String(diffPreview.stdout ?? "")), 24_000),
    pullRequestUrl,
    pullRequestSkippedReason,
  };
}

async function loadGoatCodexCliAuth(userWorkosId: string): Promise<CodexCliAuth | null> {
  let credential: Awaited<ReturnType<typeof loadGoatCodexCredential>>;
  try {
    credential = await loadGoatCodexCredential({ db: getDb(), userWorkosId });
  } catch {
    await markGoatCodexCredentialNeedsReauth({
      db: getDb(),
      userWorkosId,
      statusReason: "Codex credentials could not be decrypted. Reconnect Codex in Goat settings.",
    });
    return null;
  }
  if (!credential || credential.status !== "connected") return null;
  return { kind: "chatgpt", authJson: credential.authJson, brokered: false };
}

async function persistRefreshedGoatCodexAuth(input: {
  sandbox: SandboxHandle;
  userWorkosId: string;
  auth: CodexCliAuth;
}) {
  if (input.auth.kind !== "chatgpt") return;
  let content: string;
  try {
    const raw = await input.sandbox.files.read(`${CODEX_HOME}/auth.json`);
    content = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  } catch {
    await markGoatCodexCredentialNeedsReauth({
      db: getDb(),
      userWorkosId: input.userWorkosId,
      statusReason: "Codex did not leave a readable auth cache after running.",
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    await markGoatCodexCredentialNeedsReauth({
      db: getDb(),
      userWorkosId: input.userWorkosId,
      statusReason: "Codex auth cache was malformed after running.",
    });
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await markGoatCodexCredentialNeedsReauth({
      db: getDb(),
      userWorkosId: input.userWorkosId,
      statusReason: "Codex auth cache was malformed after running.",
    });
    return;
  }
  await rotateGoatCodexCredential({
    db: getDb(),
    userWorkosId: input.userWorkosId,
    authJson: parsed as Record<string, unknown>,
  });
}

async function resolveRepositoryAccess(input: {
  userWorkosId: string;
  repositoryFullName: string;
}): Promise<GoatCodexRepositoryAccess> {
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
        eq(goatIntegrationResources.provider, "github"),
        eq(goatIntegrationResources.resourceType, "repository"),
        sql`lower(${goatIntegrationResources.name}) = lower(${input.repositoryFullName})`,
        eq(goatIntegrations.provider, "github"),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .limit(1);

  if (!row || row.integrationStatus !== "connected" || row.resourceStatus !== "available") {
    throw new Error(
      `Connect GitHub in Goat settings and grant access to ${input.repositoryFullName} before using Codex on that repository.`,
    );
  }

  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const defaultBranch =
    typeof metadata.defaultBranch === "string" && metadata.defaultBranch.trim()
      ? metadata.defaultBranch.trim()
      : "main";
  if (!row.installationId) throw new Error("GitHub installation metadata is missing.");

  return {
    integrationId: row.integrationId,
    installationId: row.installationId,
    repositoryFullName: row.name,
    defaultBranch,
  };
}

function buildCodexTask(input: {
  systemPrompt: string;
  prompt: string;
  repository: unknown;
  goalMode?: CodexGoalModeInput | null;
}) {
  return [
    input.systemPrompt,
    "",
    input.goalMode
      ? [
          "<goal_mode>",
          `Objective: ${input.goalMode.objective}`,
          input.goalMode.tokenBudget != null
            ? `Token budget: ${input.goalMode.tokenBudget}`
            : "Token budget: runner default",
          "Use the objective as the persistent finish line while executing this GOAT Codex task.",
          "</goal_mode>",
        ].join("\n")
      : null,
    "<task>",
    input.prompt,
    "</task>",
    input.repository
      ? "Work in the checked-out repository. Make only changes needed for the task, then summarize the result."
      : "Work in the current sandbox workspace. Create or edit files only when needed for the task.",
  ].join("\n");
}

function formatCodexResult(input: {
  result: string;
  error: string | null;
  status: string;
  goal: CodexAppServerGoalSummary | null;
  repositoryFullName: string | null;
  diffStat: string | null;
  diffPreview: string | null;
  pullRequestUrl: string | null;
  pullRequestSkippedReason: string | null;
}) {
  return [
    input.result || `Codex finished with status: ${input.status}.`,
    input.goal ? formatCodexGoalSummary(input.goal) : null,
    input.error ? `\nCodex error: ${input.error}` : null,
    input.repositoryFullName ? `\nRepository: ${input.repositoryFullName}` : null,
    input.pullRequestUrl ? `Pull request: ${input.pullRequestUrl}` : null,
    input.pullRequestSkippedReason
      ? `Pull request skipped: ${input.pullRequestSkippedReason}`
      : null,
    input.diffStat ? ["", "Diff stat:", "```", input.diffStat, "```"].join("\n") : null,
    input.diffPreview
      ? ["", "Diff preview:", "```diff", input.diffPreview, "```"].join("\n")
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCodexGoalSummary(goal: CodexAppServerGoalSummary) {
  const parts = [`Goal status: ${goal.status ? formatCodexGoalStatus(goal.status) : "unknown"}`];
  if (goal.tokenBudget != null) parts.push(`budget ${goal.tokenBudget}`);
  if (goal.tokensUsed != null) parts.push(`used ${goal.tokensUsed}`);
  if (goal.timeUsedSeconds != null) parts.push(`${goal.timeUsedSeconds}s`);
  return parts.join(" - ");
}

function formatCodexGoalStatus(status: string) {
  if (status === "budgetLimited") return "budget-limited";
  if (status === "usageLimited") return "usage-limited";
  return status;
}

function normalizeRepositoryFullName(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  const githubUrl = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/#?]+)(?:[/?#].*)?$/i)?.[1];
  const candidate = (githubUrl ?? trimmed).replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    throw new Error('Codex repository must be "owner/repo" or a GitHub repository URL.');
  }
  return candidate;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Goat task was aborted.");
}
