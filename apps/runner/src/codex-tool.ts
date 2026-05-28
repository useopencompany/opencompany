import { type AgentConfig, shellQuote } from "@opencompany/agent-runtime";
import {
  calculateCodexToolUsageCost,
  isSupportedCodexToolModel,
  SUPPORTED_CODEX_TOOL_MODELS,
} from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { agentSessionArtifacts } from "@opencompany/db/schema";
import {
  buildGitHubCommandEnv,
  createKnownSecretRedactor,
  formatAmpDiffStat as formatDiffStat,
  gitAuthExtraHeaderArg,
  gitAuthHeader,
  githubRemoteUrl,
  isRecord,
  loadGitHubWorkRepository,
  normalizeCommitMessage,
  readCurrentGitBranch,
  readLocalCommitCount,
  readOptionalText,
  readPullRequestUrlForBranch,
  selectPublishBranch,
  truncateText,
} from "./amp-tool";
import type { RunnerEnv } from "./env";
import { createDraftPullRequest, getGitHubWorkInstallationToken } from "./github";
import type { HostedToolUsage } from "./hosted-tools";
import { isRunLeaseCurrent, requireLeaseWrite } from "./lease-writes";
import { type SandboxHandle, sandboxLayout } from "./sandbox";

const GITHUB_AUTH_HEADER_ENV = "GITHUB_AUTH_HEADER";

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
  const requestedCodexSessionId =
    typeof args.codexSessionId === "string" && args.codexSessionId.trim()
      ? args.codexSessionId.trim()
      : null;

  const codexTool = input.agentConfig.tools.find((tool) => tool.id === "codex");
  if (!codexTool || codexTool.id !== "codex" || !codexTool.repository) {
    throw new Error("The codex_coder tool is enabled, but no GitHub repository is bound.");
  }
  const repository = input.agentConfig.integrations.github.repositories.find(
    (candidate) => candidate.id === codexTool.repository,
  );
  if (!repository) {
    throw new Error(`Codex repository binding ${codexTool.repository} was not found.`);
  }

  const codexApiKey = loadPlatformCodexApiKey(input.env);
  const codexModel = loadPlatformCodexModel(input.env);
  const integrationRepository = await loadGitHubWorkRepository(input.workspaceId, repository);
  const githubToken = await getGitHubWorkInstallationToken({
    installationId: integrationRepository.installationId,
    repositoryFullName: repository.fullName,
  });
  if (!githubToken) {
    throw new Error(
      "GitHub App credentials are required to run Codex in a GitHub work repository.",
    );
  }
  const githubAuthHeader = gitAuthHeader(githubToken);
  const codexEnv = buildCodexCommandEnv({
    codexApiKey,
    githubAuthHeader,
    githubToken,
    toolCallId: input.toolCallId,
  });
  const redactCodexOutput = createKnownSecretRedactor([codexApiKey, githubToken, githubAuthHeader]);
  const layout = sandboxLayout(input.workdir);
  await input.sandbox.commands.run(
    `git config --global --add safe.directory ${shellQuote(layout.workRoot)}`,
  );
  const gitCheck = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && git rev-parse --is-inside-work-tree`,
    { timeoutMs: 30_000 },
  );
  if (String(gitCheck.stdout ?? "").trim() !== "true") {
    throw new Error(
      "Codex requires a cloned GitHub repository. Check the workspace GitHub installation and repository binding.",
    );
  }

  const codexStream = createCodexStreamAccumulator();
  const codexActivity = createCodexActivityFormatter();
  await input.sandbox.commands.run(`mkdir -p ${shellQuote(codexEnv.GH_CONFIG_DIR)}`, {
    timeoutMs: 30_000,
  });
  const result = await input.sandbox.commands.run(
    buildCodexCommand({
      task,
      workRoot: layout.workRoot,
      codexSessionId: requestedCodexSessionId,
      codexModel,
    }),
    {
      envs: codexEnv,
      timeoutMs: 600_000,
      onStdout: async (data: string) => {
        const redacted = redactCodexOutput(data);
        codexStream.push(redacted);
        const activity = codexActivity.push(redacted);
        if (activity) await input.onOutput?.(activity);
      },
      onStderr: async (data: string) => {
        await input.onOutput?.(redactCodexOutput(data));
      },
    },
  );
  const remainingActivity = codexActivity.finish();
  if (remainingActivity) await input.onOutput?.(remainingActivity);
  codexStream.finish();
  const codexSummary = codexStream.summary();
  const codexUsage = buildCodexToolUsage({
    modelName: codexModel,
    codexSessionId: codexSummary.sessionId,
    usage: codexSummary.usage,
  });

  await input.sandbox.commands.run(`cd ${shellQuote(layout.workRoot)} && git add -N .`, {
    timeoutMs: 60_000,
  });
  const diffStatus = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && git status --short`,
    { timeoutMs: 60_000 },
  );
  const diffStat = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && git diff HEAD --stat`,
    { timeoutMs: 60_000 },
  );
  const diffPreview = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && git diff HEAD -- | head -400`,
    { timeoutMs: 60_000 },
  );
  const hasDiff = String(diffStatus.stdout ?? "").trim().length > 0;
  const currentBranch = await readCurrentGitBranch(input.sandbox, layout.workRoot);
  const localCommitCount = await readLocalCommitCount(
    input.sandbox,
    layout.workRoot,
    repository.defaultBranch,
  );
  let branchName: string | null = null;
  let pullRequestUrl: string | null = null;

  if (args.createPullRequest === true) {
    if (!codexTool.prCapable) {
      throw new Error("Codex is not configured for pull request creation.");
    }
    const codexCreatedPrUrl = await readPullRequestUrlForBranch(
      input.sandbox,
      layout.workRoot,
      currentBranch,
      codexEnv,
    );
    if (codexCreatedPrUrl) {
      branchName = currentBranch;
      pullRequestUrl = codexCreatedPrUrl;
    }
  }

  if (args.createPullRequest === true && !pullRequestUrl && (hasDiff || localCommitCount > 0)) {
    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    branchName = selectPublishBranch({
      currentBranch,
      defaultBranch: repository.defaultBranch,
      sessionId: input.sessionId,
      now: Date.now(),
      provider: "codex",
    });
    const commitMessage = normalizeCommitMessage(
      typeof args.pullRequestTitle === "string" ? args.pullRequestTitle : task,
    );
    const prepareCommands = [
      `cd ${shellQuote(layout.workRoot)}`,
      `git config user.name ${shellQuote("OpenCompany Agent")}`,
      `git config user.email ${shellQuote("agents@opencompany.ai")}`,
      ...(branchName === currentBranch ? [] : [`git checkout -b ${shellQuote(branchName)}`]),
      ...(hasDiff ? ["git add -A", `git commit -m ${shellQuote(commitMessage)}`] : []),
      `git remote set-url origin ${shellQuote(githubRemoteUrl(repository.fullName))}`,
    ];
    await input.sandbox.commands.run(prepareCommands.join(" && "), { timeoutMs: 120_000 });
    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    await input.sandbox.commands.run(
      `cd ${shellQuote(layout.workRoot)} && git ${gitAuthExtraHeaderArg()} push origin ${shellQuote(
        branchName,
      )}`,
      { envs: { [GITHUB_AUTH_HEADER_ENV]: githubAuthHeader }, timeoutMs: 180_000 },
    );
    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    const pr = await createDraftPullRequest({
      installationId: integrationRepository.installationId,
      repositoryFullName: repository.fullName,
      title: commitMessage,
      head: branchName,
      base: repository.defaultBranch,
      body: ["Created by OpenCompany Codex.", "", `Task: ${redactCodexOutput(task)}`].join("\n"),
    });
    pullRequestUrl = pr.html_url ?? null;
  }

  const formattedDiffStat = truncateText(
    redactCodexOutput(formatDiffStat(diffStat.stdout, diffStatus.stdout)),
    4000,
  );
  const formattedDiffPreview = truncateText(
    redactCodexOutput(String(diffPreview.stdout ?? "")),
    24_000,
  );

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
      externalId: codexSummary.sessionId,
      repositoryFullName: repository.fullName,
      branchName,
      diffStat: formattedDiffStat,
      diffPreview: formattedDiffPreview,
      metadata: {
        continuedFromCodexSessionId: requestedCodexSessionId,
        codexStatus: codexSummary.status,
        codexError: codexSummary.error ? redactCodexOutput(codexSummary.error) : null,
        codexUsage: codexSummary.usage,
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      },
    });

  return {
    output: {
      repository: repository.fullName,
      codexSessionId: codexSummary.sessionId,
      continuedFromCodexSessionId: requestedCodexSessionId,
      codexStatus: codexSummary.status,
      codexResult: truncateText(redactCodexOutput(codexSummary.result), 24_000),
      codexError: codexSummary.error ? redactCodexOutput(codexSummary.error) : null,
      codexUsage: codexSummary.usage,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      diffStat: formattedDiffStat,
      diffPreview: formattedDiffPreview,
      branchName,
      pullRequestUrl,
    },
    ...(codexUsage ? { usage: codexUsage } : {}),
  };
}

export function buildCodexCommand(input: {
  task: string;
  workRoot: string;
  codexSessionId?: string | null;
  codexModel: string;
}) {
  const baseArgs = [
    "--model",
    shellQuote(input.codexModel),
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "-C",
    shellQuote(input.workRoot),
  ];
  const task = shellQuote(input.task);
  const codexSessionId = input.codexSessionId?.trim();
  if (codexSessionId) {
    return ["codex", "exec", "resume", shellQuote(codexSessionId), ...baseArgs, task].join(" ");
  }

  return ["codex", "exec", ...baseArgs, task].join(" ");
}

export function buildCodexCommandEnv(input: {
  codexApiKey: string;
  githubAuthHeader: string;
  githubToken: string;
  toolCallId: string;
}) {
  return {
    CODEX_API_KEY: input.codexApiKey,
    ...buildGitHubCommandEnv(input),
  };
}

type CodexStreamSummary = {
  sessionId: string | null;
  status: "success" | "error" | "unknown";
  result: string;
  error: string | null;
  usage: Record<string, unknown> | null;
};

export type NormalizedCodexUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  rawUsage: Record<string, unknown>;
};

export function createCodexStreamAccumulator() {
  let buffer = "";
  let sessionId: string | null = null;
  let status: CodexStreamSummary["status"] = "unknown";
  let result = "";
  let error: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let lastAgentMessage = "";

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(event)) return;

    const threadId = readOptionalText(event.thread_id) ?? readOptionalText(event.session_id);
    if (threadId) sessionId = threadId;

    if (event.type === "thread.started") {
      return;
    }

    if (event.type === "item.completed") {
      const item = isRecord(event.item) ? event.item : {};
      if (item.type === "agent_message") {
        lastAgentMessage = readOptionalText(item.text) ?? lastAgentMessage;
      }
      return;
    }

    if (event.type === "turn.completed") {
      status = "success";
      result = lastAgentMessage;
      usage = isRecord(event.usage) ? event.usage : usage;
      return;
    }

    if (event.type === "turn.failed") {
      status = "error";
      usage = isRecord(event.usage) ? event.usage : usage;
      error = readCodexError(event) ?? "Codex failed without an error message.";
      return;
    }

    if (event.type === "error") {
      status = "error";
      usage = isRecord(event.usage) ? event.usage : usage;
      error = readCodexError(event) ?? "Codex failed without an error message.";
    }
  }

  return {
    push(data: string) {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    },
    finish() {
      if (buffer.trim()) consumeLine(buffer);
      buffer = "";
    },
    summary(): CodexStreamSummary {
      return {
        sessionId,
        status,
        result: result || lastAgentMessage,
        error,
        usage,
      };
    },
  };
}

export function normalizeCodexUsage(usage: unknown): NormalizedCodexUsage | null {
  if (!isRecord(usage)) return null;

  const inputTokens = readTokenCount(
    usage,
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
  );
  const cachedInputTokens = Math.min(
    readTokenCount(
      usage,
      "cached_input_tokens",
      "cachedInputTokens",
      "input_token_details.cached_tokens",
      "input_tokens_details.cached_tokens",
      "prompt_tokens_details.cached_tokens",
      "inputTokenDetails.cacheReadTokens",
    ),
    inputTokens,
  );
  const outputTokens = readTokenCount(
    usage,
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) return null;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    rawUsage: usage,
  };
}

function buildCodexToolUsage(input: {
  modelName: string;
  codexSessionId: string | null;
  usage: Record<string, unknown> | null;
}): HostedToolUsage | undefined {
  const normalized = normalizeCodexUsage(input.usage);
  if (!normalized) return undefined;

  const cost = calculateCodexToolUsageCost({
    modelName: input.modelName,
    inputTokens: normalized.inputTokens,
    cachedInputTokens: normalized.cachedInputTokens,
    outputTokens: normalized.outputTokens,
  });

  return {
    provider: "codex",
    operation: `exec:${input.modelName}`,
    ...(input.codexSessionId ? { providerRequestId: input.codexSessionId } : {}),
    costUsdMicros: cost.providerCostUsdMicros,
    costBasis: cost.costBasis,
    rawUsage: {
      modelName: input.modelName,
      pricingVersion: cost.costBasis.pricingVersion,
      codexSessionId: input.codexSessionId,
      tokenCounts: {
        inputTokens: normalized.inputTokens,
        cachedInputTokens: normalized.cachedInputTokens,
        outputTokens: normalized.outputTokens,
      },
      usage: normalized.rawUsage,
    },
  };
}

export function createCodexActivityFormatter() {
  let buffer = "";
  let lastEmitted = "";

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return "";

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return truncateText(`${trimmed}\n`, 1000);
    }
    if (!isRecord(event)) return "";

    const summary = summarizeCodexEvent(event);
    if (!summary || summary === lastEmitted) return "";
    lastEmitted = summary;
    return `${summary}\n`;
  }

  return {
    push(data: string) {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines.map(consumeLine).join("");
    },
    finish() {
      const output = buffer.trim() ? consumeLine(buffer) : "";
      buffer = "";
      return output;
    },
  };
}

function summarizeCodexEvent(event: Record<string, unknown>) {
  const type = readOptionalText(event.type);

  if (type === "thread.started") {
    const sessionId = readOptionalText(event.thread_id) ?? readOptionalText(event.session_id);
    return sessionId ? `Codex session ${sessionId} started.` : "Codex session started.";
  }

  if (type === "item.started" || type === "item.completed") {
    const item = isRecord(event.item) ? event.item : {};
    const itemType = readOptionalText(item.type);
    if (itemType === "agent_message") {
      const text = readOptionalText(item.text);
      return text ? `Codex: ${compactWhitespace(text)}` : "";
    }
    if (itemType === "command_execution") {
      const command = readOptionalText(item.command);
      if (type === "item.completed") {
        return command
          ? `Codex finished ${truncateText(command, 180)}.`
          : "Codex finished a command.";
      }
      return command
        ? `Codex is running ${truncateText(command, 180)}.`
        : "Codex is running a command.";
    }
    if (itemType === "file_change") {
      const path = readOptionalText(item.path);
      return path ? `Codex edited ${path}.` : "Codex edited files.";
    }
    return "";
  }

  if (type === "turn.completed") return "Codex completed.";
  if (type === "turn.failed" || type === "error") {
    const error = readCodexError(event);
    return error ? `Codex failed: ${error}` : "Codex failed.";
  }

  return "";
}

function readCodexError(event: Record<string, unknown>) {
  const error = event.error;
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    return readOptionalText(error.message) ?? readOptionalText(error.code);
  }
  return readOptionalText(event.message);
}

function loadPlatformCodexApiKey(env: RunnerEnv) {
  if (!env.codexApiKey) {
    throw new Error("CODEX_API_KEY is required on the runner to use the Codex coding tool.");
  }
  return env.codexApiKey;
}

function loadPlatformCodexModel(env: RunnerEnv) {
  if (!isSupportedCodexToolModel(env.codexModel)) {
    throw new Error(
      `OPENCOMPANY_CODEX_MODEL must be one of: ${SUPPORTED_CODEX_TOOL_MODELS.join(", ")}.`,
    );
  }
  return env.codexModel;
}

function readTokenCount(record: Record<string, unknown>, ...paths: string[]) {
  for (const path of paths) {
    const value = readPath(record, path);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return 0;
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
