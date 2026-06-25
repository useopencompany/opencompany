import {
  type AgentConfig,
  type AgentRuntimeEvent,
  CODEX_DEFAULT_MODEL_ID,
  shellQuote,
} from "@opencompany/agent-runtime";
import type {
  AgentGitHubRepositoryConfig,
  AgentModelId,
  CodexReasoningEffort,
} from "@opencompany/agent-runtime/types";
import { calculateModelUsageCost, type HostedToolCostSource } from "@opencompany/billing";
import {
  loadWorkspaceCodexCredential,
  markWorkspaceCodexCredentialNeedsReauth,
  rotateWorkspaceCodexCredential,
} from "@opencompany/db/codex-auth";
import { agentSessionArtifacts } from "@opencompany/db/schema";
import { loadGitHubWorkRepository, loadGitHubWorkRepositoryByFullName } from "./amp-tool";
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
import { brokerActive, brokerBaseUrl, type RunnerEnv } from "./env";
import { createDraftPullRequest, getGitHubWorkInstallationToken } from "./github";
import type { HostedToolUsage } from "./hosted-tools";
import { isRunLeaseCurrent, requireLeaseWrite } from "./lease-writes";
import { withBrokerDelegation } from "./llm-broker-tokens";
import {
  clonePublicGitHubRepositoryIntoWorkdir,
  parsePublicGitHubRepository,
  resolvePublicGitHubDefaultBranch,
} from "./opencode-tool";
import {
  cloneGitHubRepositoryIntoWorkdir,
  commandExitResult,
  guardCommandStreamCallbacks,
  isCommandTimeoutError,
  type SandboxHandle,
  sandboxLayout,
} from "./sandbox";

const CODEX_BIN_PATH = '"$HOME/.codex/bin"';
export const CODEX_FALLBACK_NPM_PACKAGE = "@openai/codex@0.132.0";
const CODEX_PROVIDER_ID = "opencompany";
const CODEX_PROVIDER_NAME = "OpenCompany";
const CODEX_DIRECT_BASE_URL = "https://api.openai.com/v1";
const CODEX_DIRECT_API_KEY_ENV_VAR = "CODEX_API_KEY";
const BROKER_TOKEN_ENV_VAR = "OPENCOMPANY_LLM_BROKER_TOKEN";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_BILLING_MODEL: AgentModelId = CODEX_DEFAULT_MODEL_ID;
const CODEX_WORK_DIR = "codex";
const CODEX_STATE_DIR = ".codex";
const CODEX_GIT_EXCLUDE_PATHSPEC = ":(exclude).codex";

type CodexTarget =
  | {
      kind: "attached";
      repository: AgentGitHubRepositoryConfig;
    }
  | {
      kind: "workspace";
      repositoryFullName: string;
    }
  | {
      kind: "public";
      repositoryFullName: string;
    };

type MaterializedCodexTarget = Exclude<CodexTarget, { kind: "workspace" }>;

export type CodexCliAuth =
  | {
      kind: "api";
      baseUrl: string;
      apiKeyEnvVar: string;
      apiKeyValue: string;
      brokered: boolean;
    }
  | {
      kind: "chatgpt";
      authJson: Record<string, unknown>;
      brokered: false;
    };

export async function ensureCodexInstalled(sandbox: SandboxHandle) {
  const check = await sandbox.commands.run(
    `command -v codex || test -x "$HOME/.codex/bin/codex" && echo found || true`,
    { timeoutMs: 30_000 },
  );
  if (String(check.stdout ?? "").trim()) return;
  await sandbox.commands.run(`npm install -g ${shellQuote(CODEX_FALLBACK_NPM_PACKAGE)}`, {
    timeoutMs: 180_000,
  });
}

export async function runCodexCoderTool(input: {
  sandbox: SandboxHandle;
  workdir: string;
  args: unknown;
  sessionId: string;
  messageId: string;
  workspaceId: string;
  toolCallId: string;
  agentConfig: AgentConfig;
  env: RunnerEnv;
  runLeaseId: string;
  runLeaseOwner: string;
  onOutput?: (delta: string) => Promise<void> | void;
}) {
  const args = isRecord(input.args) ? input.args : {};
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) throw new Error("Codex task is required.");
  const requestedSessionId =
    typeof args.codexSessionId === "string" && args.codexSessionId.trim()
      ? args.codexSessionId.trim()
      : null;

  const codexTool = input.agentConfig.tools.find((tool) => tool.id === "codex");
  if (!codexTool || codexTool.id !== "codex") {
    throw new Error("The codex_coder tool is not enabled for this agent.");
  }

  const requestedTarget = resolveCodexTarget({
    repositories: input.agentConfig.integrations.github.repositories,
    requestedRepository: typeof args.repository === "string" ? args.repository : undefined,
    allRepositories: input.agentConfig.integrations.github.allRepositories === true,
  });
  const target = await materializeCodexWorkspaceTarget(input.workspaceId, requestedTarget);

  const layout = sandboxLayout(input.workdir);
  const codexWorkRoot = buildCodexWorkRoot(layout.workRoot);
  const repositoryFullName =
    target.kind === "attached" ? target.repository.fullName : target.repositoryFullName;
  let defaultBranch: string;
  let integrationRepository: Awaited<ReturnType<typeof loadGitHubWorkRepository>> | null = null;
  let githubToken: string | null = null;
  let githubAuthHeader: string | null = null;
  let pullRequestSkippedReason: string | null = null;

  if (target.kind === "attached") {
    defaultBranch = target.repository.defaultBranch;
    integrationRepository = await loadGitHubWorkRepository(input.workspaceId, target.repository);
    githubToken = await getGitHubWorkInstallationToken({
      installationId: integrationRepository.installationId,
      repositoryFullName,
    });
    if (!githubToken) {
      throw new Error(
        "GitHub App credentials are required to run Codex in a GitHub work repository.",
      );
    }
    githubAuthHeader = gitAuthHeader(githubToken);
    await cloneGitHubRepositoryIntoWorkdir({
      sandbox: input.sandbox,
      workdir: codexWorkRoot,
      repositoryFullName,
      defaultBranch,
      githubToken,
    });
  } else {
    defaultBranch = await resolvePublicGitHubDefaultBranch(input.sandbox, repositoryFullName);
    await clonePublicGitHubRepositoryIntoWorkdir({
      sandbox: input.sandbox,
      workdir: codexWorkRoot,
      repositoryFullName,
      defaultBranch,
    });
  }

  const model = input.env.codexModel;

  const runWithModelAuth = async (auth: CodexCliAuth) => {
    const serializedAuthJson = auth.kind === "chatgpt" ? JSON.stringify(auth.authJson) : null;
    const redact = createKnownSecretRedactor([
      auth.kind === "api" ? auth.apiKeyValue : null,
      serializedAuthJson,
      input.env.openaiCodexApiKey,
      githubToken,
      githubAuthHeader,
    ]);
    await input.sandbox.commands.run(
      `git config --global --add safe.directory ${shellQuote(codexWorkRoot)}`,
    );

    await ensureCodexInstalled(input.sandbox);

    const codexHome = buildCodexHome(codexWorkRoot);
    const configPath = `${codexHome}/config.toml`;
    await input.sandbox.commands.run(`mkdir -p ${shellQuote(codexHome)}`, {
      timeoutMs: 30_000,
    });
    await input.sandbox.commands.run(
      `cd ${shellQuote(codexWorkRoot)} && grep -qxF '/${CODEX_STATE_DIR}/' .git/info/exclude || printf '\\n/${CODEX_STATE_DIR}/\\n' >> .git/info/exclude`,
      { timeoutMs: 30_000 },
    );
    await input.sandbox.files.write(configPath, buildCodexConfigForAuth(auth));
    if (serializedAuthJson) {
      await input.sandbox.files.write(`${codexHome}/auth.json`, serializedAuthJson);
    }

    const codexEnv = {
      CODEX_HOME: codexHome,
      ...(auth.kind === "api" ? { [auth.apiKeyEnvVar]: auth.apiKeyValue } : {}),
      ...(target.kind === "attached" && githubToken && githubAuthHeader
        ? buildGitHubCommandEnv({
            githubAuthHeader,
            githubToken,
            repositoryFullName,
            toolCallId: input.toolCallId,
          })
        : {}),
    };

    const stream = createCodexStreamAccumulator();
    const codexCommand = `cd ${shellQuote(codexWorkRoot)} && export PATH=${CODEX_BIN_PATH}:"$PATH" && ${buildCodexCommand(
      {
        task,
        workRoot: codexWorkRoot,
        model,
        sessionId: requestedSessionId,
      },
    )}`;
    let timedOut = false;
    let result: {
      stdout?: unknown;
      stderr?: unknown;
      exitCode?: number | null;
    };
    const guardedRun = guardCommandStreamCallbacks({
      envs: codexEnv,
      timeoutMs: input.env.codexTimeoutMs,
      onStdout: async (data: string) => {
        const redacted = redact(data);
        const activity = stream.push(redacted);
        if (activity) await input.onOutput?.(activity);
      },
      onStderr: async (data: string) => {
        await input.onOutput?.(redact(data));
      },
    });

    try {
      result = await input.sandbox.commands.run(codexCommand, guardedRun.options);
    } catch (error) {
      const exitResult = commandExitResult(error);
      if (exitResult) {
        result = exitResult;
      } else if (isCommandTimeoutError(error)) {
        timedOut = true;
        result = { stdout: "", stderr: "", exitCode: null };
        await input.onOutput?.("Codex: timed out — capturing the partial diff.\n");
      } else {
        throw error;
      }
    }
    await guardedRun.rethrow();
    stream.finish();
    const summary = stream.summary({
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      stdout: redact(String(result.stdout ?? "")),
      stderr: redact(String(result.stderr ?? "")),
      timedOut,
    });
    await persistRefreshedWorkspaceCodexAuth({
      sandbox: input.sandbox,
      codexHome,
      workspaceId: input.workspaceId,
      auth,
    });

    await input.sandbox.commands.run(
      `cd ${shellQuote(codexWorkRoot)} && ${codexIntentToAddCommand()}`,
      {
        timeoutMs: 60_000,
      },
    );
    const diffStatus = await input.sandbox.commands.run(
      `cd ${shellQuote(codexWorkRoot)} && git status --short ${codexGitPathspecArgs()}`,
      { timeoutMs: 60_000 },
    );
    const diffStat = await input.sandbox.commands.run(
      `cd ${shellQuote(codexWorkRoot)} && git diff HEAD --stat ${codexGitPathspecArgs()}`,
      { timeoutMs: 60_000 },
    );
    const diffPreview = await input.sandbox.commands.run(
      `cd ${shellQuote(codexWorkRoot)} && git diff HEAD ${codexGitPathspecArgs()} | head -400`,
      { timeoutMs: 60_000 },
    );
    const hasDiff = String(diffStatus.stdout ?? "").trim().length > 0;
    const currentBranch = await readCurrentGitBranch(input.sandbox, codexWorkRoot);
    const localCommitCount = await readLocalCommitCount(
      input.sandbox,
      codexWorkRoot,
      defaultBranch,
    );
    let branchName: string | null = null;
    let pullRequestUrl: string | null = null;

    if (args.createPullRequest === true && target.kind === "public") {
      pullRequestSkippedReason = "public_repository_without_workspace_installation";
    }

    if (args.createPullRequest === true && target.kind === "attached") {
      if (!codexTool.prCapable) {
        throw new Error("Codex is not configured for pull request creation.");
      }
      const existingPrUrl = await readPullRequestUrlForBranch(
        input.sandbox,
        codexWorkRoot,
        currentBranch,
        codexEnv,
      );
      if (existingPrUrl) {
        branchName = currentBranch;
        pullRequestUrl = existingPrUrl;
      }
    }

    if (
      args.createPullRequest === true &&
      target.kind === "attached" &&
      timedOut &&
      !pullRequestUrl
    ) {
      pullRequestSkippedReason = "coder_timed_out";
    }

    if (
      args.createPullRequest === true &&
      target.kind === "attached" &&
      !timedOut &&
      !pullRequestUrl &&
      (hasDiff || localCommitCount > 0)
    ) {
      await requireLeaseWrite(
        isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
      );
      branchName = selectPublishBranch({
        currentBranch,
        defaultBranch,
        sessionId: input.sessionId,
        now: Date.now(),
        prefix: "codex",
      });
      const commitMessage = normalizeCommitMessage(
        typeof args.pullRequestTitle === "string" ? args.pullRequestTitle : task,
        "Apply Codex changes",
      );
      const prepareCommands = [
        `cd ${shellQuote(codexWorkRoot)}`,
        `git config user.name ${shellQuote("OpenCompany Agent")}`,
        `git config user.email ${shellQuote("agents@opencompany.ai")}`,
        ...(branchName === currentBranch ? [] : [`git checkout -b ${shellQuote(branchName)}`]),
        ...(hasDiff
          ? [`git add -A ${codexGitPathspecArgs()}`, `git commit -m ${shellQuote(commitMessage)}`]
          : []),
        `git remote set-url origin ${shellQuote(githubRemoteUrl(repositoryFullName))}`,
      ];
      await input.sandbox.commands.run(prepareCommands.join(" && "), {
        timeoutMs: 120_000,
      });
      await requireLeaseWrite(
        isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
      );
      await input.sandbox.commands.run(
        `cd ${shellQuote(codexWorkRoot)} && git ${gitAuthExtraHeaderArg()} push origin ${shellQuote(
          branchName,
        )}`,
        {
          envs: { [GITHUB_AUTH_HEADER_ENV]: githubAuthHeader ?? "" },
          timeoutMs: 180_000,
        },
      );
      await requireLeaseWrite(
        isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
      );
      if (!integrationRepository) {
        throw new Error("Attached repository metadata is required to create a Codex pull request.");
      }
      const pr = await createDraftPullRequest({
        installationId: integrationRepository.installationId,
        repositoryFullName,
        title: commitMessage,
        head: branchName,
        base: defaultBranch,
        body: ["Created by OpenCompany Codex.", "", `Task: ${redact(task)}`].join("\n"),
      });
      pullRequestUrl = pr.html_url ?? null;
    }

    const redactedDiffStat = truncateText(
      redact(formatDiffStat(diffStat.stdout, diffStatus.stdout)),
      4000,
    );
    const redactedDiffPreview = truncateText(redact(String(diffPreview.stdout ?? "")), 24_000);

    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    await getDb()
      .insert(agentSessionArtifacts)
      .values({
        sessionId: input.sessionId,
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        toolName: "codex_coder",
        kind: "codex_run",
        title: task,
        url: pullRequestUrl,
        externalId: summary.sessionId,
        repositoryFullName,
        branchName,
        diffStat: redactedDiffStat,
        diffPreview: redactedDiffPreview,
        metadata: {
          repositoryTarget: target.kind,
          model,
          codexStatus: summary.status,
          codexError: summary.error ? redact(summary.error) : null,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
          pullRequestSkippedReason,
          brokered: auth.brokered,
          usageMissing: summary.usage == null,
        },
      });

    const usage = codexHostedToolUsage({
      model,
      summary,
      brokered: auth.brokered,
      subscriptionBacked: auth.kind === "chatgpt",
    });
    return {
      repository: repositoryFullName,
      repositoryTarget: target.kind,
      model,
      codexSessionId: summary.sessionId,
      codexStatus: summary.status,
      codexResult: truncateText(redact(summary.result), 24_000),
      codexError: summary.error ? redact(summary.error) : null,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      diffStat: redactedDiffStat,
      diffPreview: redactedDiffPreview,
      branchName,
      pullRequestUrl,
      pullRequestSkippedReason,
      ...(usage ? { usage } : {}),
    };
  };

  const workspaceCodexAuth = await loadWorkspaceCodexCliAuth(input.workspaceId);
  if (workspaceCodexAuth) return runWithModelAuth(workspaceCodexAuth);

  if (!codexApiKeyFallbackEnabled()) {
    throw new Error("Connect Codex in company settings before running Codex.");
  }

  if (brokerActive(input.env) && input.env.publicUrl) {
    return withBrokerDelegation(
      {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        toolName: "codex_coder",
        provider: "openai",
        ttlMs: input.env.codexTimeoutMs + 10 * 60 * 1000,
      },
      (minted) =>
        runWithModelAuth({
          kind: "api",
          baseUrl: brokerBaseUrl(input.env.publicUrl as string, "openai"),
          apiKeyEnvVar: BROKER_TOKEN_ENV_VAR,
          apiKeyValue: minted.token,
          brokered: true,
        }),
    );
  }

  const codexApiKey = input.env.openaiCodexApiKey;
  if (!codexApiKey) {
    throw new Error("OPENAI_CODEX_API_KEY is required to run codex_coder.");
  }

  return runWithModelAuth({
    kind: "api",
    baseUrl: CODEX_DIRECT_BASE_URL,
    apiKeyEnvVar: CODEX_DIRECT_API_KEY_ENV_VAR,
    apiKeyValue: codexApiKey,
    brokered: false,
  });
}

export function buildCodexCommand(input: {
  task: string;
  workRoot: string;
  model: string;
  sessionId?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  planModeReasoningEffort?: CodexReasoningEffort | null;
}) {
  const parts = [
    "codex",
    "exec",
    "--json",
    "--cd",
    shellQuote(input.workRoot),
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
  ];
  const configArgs = [
    ...(input.reasoningEffort
      ? ["-c", shellQuote(`model_reasoning_effort=${input.reasoningEffort}`)]
      : []),
    ...(input.planModeReasoningEffort
      ? ["-c", shellQuote(`plan_mode_reasoning_effort=${input.planModeReasoningEffort}`)]
      : []),
  ];
  const sessionId = input.sessionId?.trim();
  if (sessionId) {
    parts.push(
      "resume",
      "-m",
      shellQuote(input.model),
      ...configArgs,
      shellQuote(sessionId),
      shellQuote(input.task),
    );
    return parts.join(" ");
  }
  parts.push("-m", shellQuote(input.model), ...configArgs, shellQuote(input.task));
  return parts.join(" ");
}

export function buildCodexWorkRoot(workRoot: string) {
  return `${workRoot}/${CODEX_WORK_DIR}`;
}

export function buildCodexHome(workRoot: string) {
  return `${workRoot}/${CODEX_STATE_DIR}`;
}

function codexGitPathspecArgs() {
  return `-- . ${shellQuote(CODEX_GIT_EXCLUDE_PATHSPEC)}`;
}

export function codexIntentToAddCommand() {
  return [
    "tmp=$(mktemp)",
    'git ls-files --others --exclude-standard -z > "$tmp"',
    'if [ -s "$tmp" ]; then xargs -0 git add -N -- < "$tmp"; fi',
    'rm -f "$tmp"',
  ].join(" && ");
}

export function buildCodexConfig(input: { baseUrl: string; apiKeyEnvVar: string }) {
  return [
    `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
    `model_verbosity = "medium"`,
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = ${tomlString(CODEX_PROVIDER_NAME)}`,
    `base_url = ${tomlString(input.baseUrl)}`,
    `env_key = ${tomlString(input.apiKeyEnvVar)}`,
    `wire_api = "responses"`,
    "",
  ].join("\n");
}

export function buildCodexSubscriptionConfig() {
  return [
    'cli_auth_credentials_store = "file"',
    'forced_login_method = "chatgpt"',
    `model_verbosity = "medium"`,
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
  ].join("\n");
}

export function buildCodexConfigForAuth(auth: CodexCliAuth) {
  if (auth.kind === "chatgpt") return buildCodexSubscriptionConfig();
  return buildCodexConfig({
    baseUrl: auth.baseUrl,
    apiKeyEnvVar: auth.apiKeyEnvVar,
  });
}

export async function loadWorkspaceCodexCliAuth(workspaceId: string): Promise<CodexCliAuth | null> {
  let credential: Awaited<ReturnType<typeof loadWorkspaceCodexCredential>>;
  try {
    credential = await loadWorkspaceCodexCredential({ db: getDb(), workspaceId });
  } catch {
    await markWorkspaceCodexCredentialNeedsReauth({
      db: getDb(),
      workspaceId,
      statusReason: "Codex credentials could not be decrypted. Reconnect Codex in settings.",
    });
    return null;
  }
  if (!credential || credential.status !== "connected") return null;
  return {
    kind: "chatgpt",
    authJson: credential.authJson,
    brokered: false,
  };
}

export async function persistRefreshedWorkspaceCodexAuth(input: {
  sandbox: SandboxHandle;
  codexHome: string;
  workspaceId: string;
  auth: CodexCliAuth;
}) {
  if (input.auth.kind !== "chatgpt") return;
  let content: string;
  try {
    content = sandboxFileContentToText(
      await input.sandbox.files.read(`${input.codexHome}/auth.json`),
    );
  } catch {
    await markWorkspaceCodexCredentialNeedsReauth({
      db: getDb(),
      workspaceId: input.workspaceId,
      statusReason: "Codex did not leave a readable auth cache after running.",
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    await markWorkspaceCodexCredentialNeedsReauth({
      db: getDb(),
      workspaceId: input.workspaceId,
      statusReason: "Codex auth cache was malformed after running.",
    });
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await markWorkspaceCodexCredentialNeedsReauth({
      db: getDb(),
      workspaceId: input.workspaceId,
      statusReason: "Codex auth cache was malformed after running.",
    });
    return;
  }
  await rotateWorkspaceCodexCredential({
    db: getDb(),
    workspaceId: input.workspaceId,
    authJson: parsed as Record<string, unknown>,
  });
}

function sandboxFileContentToText(content: string | Uint8Array) {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

export function codexApiKeyFallbackEnabled() {
  const value = process.env.RUNNER_CODEX_API_KEY_FALLBACK_ENABLED?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return process.env.NODE_ENV !== "production";
}

export function resolveCodexTarget(input: {
  repositories: AgentGitHubRepositoryConfig[];
  requestedRepository?: string | undefined;
  allRepositories?: boolean;
}): CodexTarget {
  const allRepositories = input.allRepositories === true;
  const requested = input.requestedRepository?.trim();
  if (requested) {
    const requestedLower = requested.toLowerCase();
    const attached = input.repositories.find(
      (repository) =>
        repository.id === requested || repository.fullName.toLowerCase() === requestedLower,
    );
    if (attached) return { kind: "attached", repository: attached };

    const publicRepositoryFullName = parsePublicGitHubRepository(requested);
    if (publicRepositoryFullName) {
      const attachedByRepositoryName = resolveSingleAttachedRepositoryByName(
        input.repositories,
        publicRepositoryFullName,
      );
      if (attachedByRepositoryName)
        return { kind: "attached", repository: attachedByRepositoryName };
      if (allRepositories)
        return {
          kind: "workspace",
          repositoryFullName: publicRepositoryFullName,
        };
      return { kind: "public", repositoryFullName: publicRepositoryFullName };
    }

    throw new Error(
      `Requested repository "${requested}" is not an attached repository or a supported public GitHub repository. Use an attached repository id/full name, public owner/repo, or https://github.com/owner/repo URL.`,
    );
  }

  if (input.repositories.length === 1)
    return { kind: "attached", repository: input.repositories[0]! };

  if (input.repositories.length > 1) {
    throw new Error(
      `More than one repository is attached. Set the repository argument (owner/repo, id, or public GitHub URL) to choose one. Attached repositories: ${input.repositories
        .map((repository) => repository.fullName)
        .join(", ")}.`,
    );
  }

  throw new Error(
    allRepositories
      ? "codex_coder needs the repository argument (owner/repo): this agent has integration-wide GitHub access with no default repository attached."
      : "codex_coder needs a repository argument when no GitHub repository is attached. Use a public GitHub owner/repo or https://github.com/owner/repo URL.",
  );
}

async function materializeCodexWorkspaceTarget(
  workspaceId: string,
  target: CodexTarget,
): Promise<MaterializedCodexTarget> {
  if (target.kind !== "workspace") return target;
  const resolved = await loadGitHubWorkRepositoryByFullName(workspaceId, target.repositoryFullName);
  if (resolved) return { kind: "attached", repository: resolved.repository };
  return { kind: "public", repositoryFullName: target.repositoryFullName };
}

function resolveSingleAttachedRepositoryByName(
  repositories: AgentGitHubRepositoryConfig[],
  requestedRepositoryFullName: string,
) {
  if (repositories.length !== 1) return null;
  const repository = repositories[0]!;
  return repositoryName(repository.fullName).toLowerCase() ===
    repositoryName(requestedRepositoryFullName).toLowerCase()
    ? repository
    : null;
}

function repositoryName(repositoryFullName: string) {
  return repositoryFullName.split("/")[1] ?? "";
}

interface CodexUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

type CodexStreamSummary = {
  sessionId: string | null;
  status: "success" | "error" | "timeout" | "unknown";
  result: string;
  error: string | null;
  usage: CodexUsage | null;
};

export function createCodexStreamAccumulator() {
  let buffer = "";
  let sessionId: string | null = null;
  let resultText = "";
  let error: string | null = null;
  let parsedEvents: Record<string, unknown>[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let sawTokens = false;

  function ingestEvent(event: unknown): string | null {
    if (!isRecord(event)) return null;
    parsedEvents.push(event);
    const foundSessionId = firstDeepString(event, [
      "session_id",
      "sessionId",
      "thread_id",
      "threadId",
      "conversation_id",
      "conversationId",
      "id",
    ]);
    if (foundSessionId && !sessionId) sessionId = foundSessionId;

    const type = firstString(event.type, isRecord(event.msg) ? event.msg.type : undefined) ?? "";
    const text = firstDeepString(event, ["delta", "text", "content", "message"]);
    let activity: string | null = null;
    if (text && isAssistantTextEvent(type, event)) {
      resultText += text;
      activity = compactActivity(`Codex: ${text}`);
    } else if (/tool|exec|command|patch|file/i.test(type)) {
      const label = firstDeepString(event, ["name", "command", "path", "title"]);
      activity = compactActivity(`Codex: ${label ?? type}`);
    }

    const errorText = firstDeepString(event, ["error", "error_message", "message"]);
    if (errorText && /error|failed|failure/i.test(type)) error = errorText;
    accumulateTokens(event);
    return activity;
  }

  function accumulateTokens(event: Record<string, unknown>) {
    const usage = findUsageRecord(event);
    if (!usage) return;
    const input = numberFrom(
      usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens,
    );
    const output = numberFrom(
      usage.output_tokens ??
        usage.outputTokens ??
        usage.completion_tokens ??
        usage.completionTokens,
    );
    const cacheRead = numberFrom(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cached_input_tokens,
    );
    const cacheWrite = numberFrom(
      usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
    );
    if (input != null) {
      inputTokens = input;
      sawTokens = true;
    }
    if (output != null) {
      outputTokens = output;
      sawTokens = true;
    }
    if (cacheRead != null) {
      cacheReadTokens = cacheRead;
      sawTokens = true;
    }
    if (cacheWrite != null) {
      cacheWriteTokens = cacheWrite;
      sawTokens = true;
    }
  }

  function consumeLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
    try {
      return ingestEvent(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  return {
    push(chunk: string): string | null {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const activities: string[] = [];
      for (const line of lines) {
        const activity = consumeLine(line);
        if (activity) activities.push(activity);
      }
      return activities.length ? `${activities.join("\n")}\n` : null;
    },
    finish() {
      if (buffer.trim()) consumeLine(buffer);
      buffer = "";
    },
    drainEvents() {
      const events = parsedEvents;
      parsedEvents = [];
      return events;
    },
    summary(input: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut?: boolean;
    }): CodexStreamSummary {
      const status: CodexStreamSummary["status"] = input.timedOut
        ? "timeout"
        : error
          ? "error"
          : input.exitCode === 0
            ? "success"
            : input.exitCode == null
              ? "unknown"
              : "error";
      const usage: CodexUsage | null = sawTokens
        ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            ...(cacheReadTokens ? { cache_read_input_tokens: cacheReadTokens } : {}),
            ...(cacheWriteTokens ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
          }
        : null;
      return {
        sessionId,
        status,
        result: resultText.trim() || input.stdout.trim(),
        error:
          status === "timeout"
            ? "Codex timed out before finishing. The partial diff is shown below."
            : (error ?? (status === "error" && input.stderr.trim() ? input.stderr.trim() : null)),
        usage,
      };
    },
  };
}

export function codexRuntimeEventsFromJsonEvent(
  event: unknown,
  messageId: string,
): AgentRuntimeEvent[] {
  if (!isRecord(event)) return [];
  const msg = isRecord(event.msg) ? event.msg : null;
  const type = firstString(event.type, msg?.type);
  if (type !== "item.started" && type !== "item.completed") return [];

  const item = isRecord(event.item) ? event.item : isRecord(msg?.item) ? msg.item : null;
  if (!item || firstString(item.type) !== "command_execution") return [];

  const itemId = firstString(item.id);
  const command = firstString(item.command);
  if (!itemId || !command) return [];

  const toolCallId = `codex:${itemId}`;
  if (type === "item.started") {
    return [
      {
        type: "tool.started",
        payload: {
          messageId,
          toolCallId,
          name: "shell",
          input: { command },
        },
      },
    ];
  }

  const exitCode = numberFrom(item.exit_code);
  const status = firstString(item.status);
  const outputPreview = firstString(item.aggregated_output) ?? "";
  if (status === "failed" || (exitCode != null && exitCode !== 0)) {
    const message =
      exitCode == null ? "Codex command failed." : `Codex command exited with code ${exitCode}.`;
    return [
      {
        type: "tool.failed",
        payload: {
          messageId,
          toolCallId,
          name: "shell",
          ...(outputPreview ? { outputPreview } : {}),
          output: {
            command,
            exitCode,
            output: outputPreview,
          },
          error: {
            message,
            code: "codex_command_failed",
            recoverable: true,
          },
        },
      },
    ];
  }

  return [
    {
      type: "tool.completed",
      payload: {
        messageId,
        toolCallId,
        name: "shell",
        ...(outputPreview ? { outputPreview } : {}),
        output: {
          command,
          exitCode,
          output: outputPreview,
        },
      },
    },
  ];
}

export function codexHostedToolUsage(input: {
  model: string;
  summary: Pick<CodexStreamSummary, "usage">;
  brokered?: boolean;
  subscriptionBacked?: boolean;
}): HostedToolUsage | null {
  const tokens = input.summary.usage;
  if (!tokens) return null;
  const billingModel = codexBillingModel(input.model);
  if (input.subscriptionBacked) {
    return {
      provider: "codex",
      operation: "session",
      costUsdMicros: 0,
      costSource: "subscription",
      rawUsage: {
        ...tokens,
        model: input.model,
        billing_model: billingModel,
        cost_source: "subscription",
        display_only: true,
      },
    } satisfies HostedToolUsage;
  }
  if (input.brokered) {
    return {
      provider: "codex",
      operation: "session",
      costUsdMicros: 0,
      costSource: "broker_metered",
      rawUsage: {
        ...tokens,
        model: input.model,
        billing_model: billingModel,
        cost_source: "broker_metered",
        display_only: true,
      },
    } satisfies HostedToolUsage;
  }

  const computed = calculateModelUsageCost({
    modelName: billingModel,
    inputTokens:
      tokens.input_tokens +
      (tokens.cache_read_input_tokens ?? 0) +
      (tokens.cache_creation_input_tokens ?? 0),
    inputNoCacheTokens: tokens.input_tokens,
    inputCacheReadTokens: tokens.cache_read_input_tokens ?? 0,
    inputCacheWriteTokens: tokens.cache_creation_input_tokens ?? 0,
    outputTokens: tokens.output_tokens,
  });
  const costSource: HostedToolCostSource = "platform_model_pricing";
  return {
    provider: "codex",
    operation: "session",
    costUsdMicros: computed.billable ? computed.providerCostUsdMicros : 0,
    costSource,
    rawUsage: {
      ...tokens,
      model: input.model,
      billing_model: billingModel,
      cost_source: costSource,
    },
  } satisfies HostedToolUsage;
}

function codexBillingModel(model: string): AgentModelId {
  if (model === DEFAULT_CODEX_MODEL || model === DEFAULT_CODEX_BILLING_MODEL) {
    return DEFAULT_CODEX_BILLING_MODEL;
  }
  return model.includes("/") ? (model as AgentModelId) : (`openai/${model}` as AgentModelId);
}

function isAssistantTextEvent(type: string, event: Record<string, unknown>) {
  if (/assistant|agent|message|text|delta|response/i.test(type)) return true;
  const item = isRecord(event.item) ? event.item : null;
  const itemType = firstString(item?.type);
  if (itemType && /assistant|agent.*message|message/i.test(itemType)) return true;
  const role = firstDeepString(event, ["role"]);
  return role === "assistant";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstDeepString(value: unknown, keys: string[]): string | null {
  const seen = new Set<unknown>();
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    for (const key of keys) {
      const found = current[key];
      if (typeof found === "string" && found.trim()) return found.trim();
    }
    for (const nested of Object.values(current)) {
      if (isRecord(nested)) stack.push(nested);
      if (Array.isArray(nested)) stack.push(...nested);
    }
  }
  return null;
}

function findUsageRecord(value: unknown): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    if (
      numberFrom(current.input_tokens ?? current.inputTokens ?? current.prompt_tokens) != null ||
      numberFrom(current.output_tokens ?? current.outputTokens ?? current.completion_tokens) != null
    ) {
      return current;
    }
    if (isRecord(current.usage)) return current.usage;
    for (const nested of Object.values(current)) {
      if (isRecord(nested)) stack.push(nested);
      if (Array.isArray(nested)) stack.push(...nested);
    }
  }
  return null;
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

function compactActivity(value: string) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}
