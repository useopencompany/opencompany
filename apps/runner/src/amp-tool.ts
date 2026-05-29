import { type AgentConfig, shellQuote } from "@opencompany/agent-runtime";
import type { AgentGitHubRepositoryConfig } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import {
  agentSessionArtifacts,
  workspaceIntegrationResources,
  workspaceIntegrations,
} from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import type { RunnerEnv } from "./env";
import { createDraftPullRequest, getGitHubWorkInstallationToken } from "./github";
import { isRunLeaseCurrent, requireLeaseWrite } from "./lease-writes";
import { type SandboxHandle, sandboxLayout } from "./sandbox";

const GITHUB_AUTH_HEADER_ENV = "GITHUB_AUTH_HEADER";
const AMP_MODES = ["smart", "large", "rush", "deep"] as const;
const DEFAULT_AMP_MODE = "smart";
type AmpMode = (typeof AMP_MODES)[number];

export async function runAmpCoderTool(input: {
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
  if (!task) throw new Error("AMP task is required.");
  const requestedAmpThreadId =
    typeof args.ampThreadId === "string" && args.ampThreadId.trim()
      ? args.ampThreadId.trim()
      : null;
  const ampMode = readAmpMode(args.mode);

  const ampTool = input.agentConfig.tools.find((tool) => tool.id === "amp");
  if (!ampTool || ampTool.id !== "amp" || !ampTool.repository) {
    throw new Error("The amp_coder tool is enabled, but no GitHub repository is bound.");
  }
  const repository = input.agentConfig.integrations.github.repositories.find(
    (candidate) => candidate.id === ampTool.repository,
  );
  if (!repository) {
    throw new Error(`AMP repository binding ${ampTool.repository} was not found.`);
  }

  const ampApiKey = loadPlatformAmpApiKey(input.env);
  const integrationRepository = await loadGitHubWorkRepository(input.workspaceId, repository);
  const githubToken = await getGitHubWorkInstallationToken({
    installationId: integrationRepository.installationId,
    repositoryFullName: repository.fullName,
  });
  if (!githubToken) {
    throw new Error("GitHub App credentials are required to run AMP in a GitHub work repository.");
  }
  const githubAuthHeader = gitAuthHeader(githubToken);
  const ampEnv = buildAmpCommandEnv({
    ampApiKey,
    githubAuthHeader,
    githubToken,
    toolCallId: input.toolCallId,
  });
  const redactAmpOutput = createKnownSecretRedactor([ampApiKey, githubToken, githubAuthHeader]);
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
      "AMP requires a cloned GitHub repository. Check the workspace GitHub installation and repository binding.",
    );
  }
  const ampStream = createAmpStreamAccumulator();
  const ampActivity = createAmpActivityFormatter();
  await input.sandbox.commands.run(`mkdir -p ${shellQuote(ampEnv.GH_CONFIG_DIR)}`, {
    timeoutMs: 30_000,
  });
  const result = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && ${buildAmpCommand({
      task,
      ampThreadId: requestedAmpThreadId,
      mode: ampMode,
    })}`,
    {
      envs: ampEnv,
      timeoutMs: 600_000,
      onStdout: async (data: string) => {
        const redacted = redactAmpOutput(data);
        ampStream.push(redacted);
        const activity = ampActivity.push(redacted);
        if (activity) await input.onOutput?.(activity);
      },
      onStderr: async (data: string) => {
        await input.onOutput?.(redactAmpOutput(data));
      },
    },
  );
  const remainingActivity = ampActivity.finish();
  if (remainingActivity) await input.onOutput?.(remainingActivity);
  ampStream.finish();
  const ampSummary = ampStream.summary({
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    stdout: redactAmpOutput(String(result.stdout ?? "")),
    stderr: redactAmpOutput(String(result.stderr ?? "")),
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
    if (!ampTool.prCapable) {
      throw new Error("AMP is not configured for pull request creation.");
    }
    const ampCreatedPrUrl = await readPullRequestUrlForBranch(
      input.sandbox,
      layout.workRoot,
      currentBranch,
      ampEnv,
    );
    if (ampCreatedPrUrl) {
      branchName = currentBranch;
      pullRequestUrl = ampCreatedPrUrl;
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
      body: ["Created by OpenCompany AMP.", "", `Task: ${redactAmpOutput(task)}`].join("\n"),
    });
    pullRequestUrl = pr.html_url ?? null;
  }

  await requireLeaseWrite(
    isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
  );
  await getDb()
    .insert(agentSessionArtifacts)
    .values({
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      toolName: "amp_coder",
      kind: "amp_run",
      title: task,
      url: pullRequestUrl,
      externalId: ampSummary.threadId,
      repositoryFullName: repository.fullName,
      branchName,
      diffStat: truncateText(
        redactAmpOutput(formatAmpDiffStat(diffStat.stdout, diffStatus.stdout)),
        4000,
      ),
      diffPreview: truncateText(redactAmpOutput(String(diffPreview.stdout ?? "")), 24_000),
      metadata: {
        continuedFromAmpThreadId: requestedAmpThreadId,
        ampStatus: ampSummary.status,
        ampError: ampSummary.error ? redactAmpOutput(ampSummary.error) : null,
        ampDurationMs: ampSummary.durationMs,
        ampNumTurns: ampSummary.numTurns,
        ampPermissionDenials: ampSummary.permissionDenials.map(redactAmpOutput),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      },
    });

  return {
    repository: repository.fullName,
    ampThreadId: ampSummary.threadId,
    continuedFromAmpThreadId: requestedAmpThreadId,
    ampStatus: ampSummary.status,
    ampResult: truncateText(redactAmpOutput(ampSummary.result), 24_000),
    ampError: ampSummary.error ? redactAmpOutput(ampSummary.error) : null,
    ampDurationMs: ampSummary.durationMs,
    ampNumTurns: ampSummary.numTurns,
    ampPermissionDenials: ampSummary.permissionDenials.map(redactAmpOutput),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    diffStat: truncateText(
      redactAmpOutput(formatAmpDiffStat(diffStat.stdout, diffStatus.stdout)),
      4000,
    ),
    diffPreview: truncateText(redactAmpOutput(String(diffPreview.stdout ?? "")), 24_000),
    branchName,
    pullRequestUrl,
  };
}

export function buildAmpCommand(input: {
  task: string;
  ampThreadId?: string | null;
  mode?: AmpMode | null;
}) {
  const task = shellQuote(input.task);
  const ampThreadId = input.ampThreadId?.trim();
  const mode = input.mode ?? DEFAULT_AMP_MODE;
  if (ampThreadId) {
    return [
      "amp",
      "threads",
      "continue",
      "--dangerously-allow-all",
      "--mode",
      mode,
      "-x",
      task,
      shellQuote(ampThreadId),
    ].join(" ");
  }

  return `amp --dangerously-allow-all --mode ${mode} -x ${task}`;
}

function readAmpMode(value: unknown): AmpMode {
  if (value == null || value === "") return DEFAULT_AMP_MODE;
  if (typeof value !== "string") {
    throw new Error("AMP mode must be a string.");
  }

  const mode = value.trim();
  if (AMP_MODES.includes(mode as AmpMode)) return mode as AmpMode;

  throw new Error(`Unsupported AMP mode "${mode}". Supported AMP modes: ${AMP_MODES.join(", ")}.`);
}

export function buildAmpCommandEnv(input: {
  ampApiKey: string;
  githubAuthHeader: string;
  githubToken: string;
  toolCallId: string;
}) {
  return {
    AMP_API_KEY: input.ampApiKey,
    ...buildGitHubCommandEnv(input),
  };
}

export function buildGitHubCommandEnv(input: {
  githubAuthHeader: string;
  githubToken: string;
  toolCallId: string;
}) {
  return {
    GH_TOKEN: input.githubToken,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
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
}) {
  if (input.currentBranch && input.currentBranch !== input.defaultBranch) {
    return input.currentBranch;
  }

  return `opencompany/amp-${input.sessionId.slice(-8)}-${input.now}`;
}

export async function loadGitHubWorkRepository(
  workspaceId: string,
  repository: AgentGitHubRepositoryConfig,
) {
  const db = getDb();
  const baseQuery = db
    .select({
      integrationId: workspaceIntegrations.id,
      fullName: workspaceIntegrationResources.name,
      installationId: workspaceIntegrations.externalId,
      connectionLabel: workspaceIntegrations.connectionLabel,
      connectionStatus: workspaceIntegrations.status,
      connectionStatusReason: workspaceIntegrations.statusReason,
      resourceStatus: workspaceIntegrationResources.status,
      resourceStatusReason: workspaceIntegrationResources.statusReason,
    })
    .from(workspaceIntegrationResources)
    .innerJoin(
      workspaceIntegrations,
      eq(workspaceIntegrationResources.integrationId, workspaceIntegrations.id),
    );
  const rows = repository.binding
    ? await baseQuery
        .where(
          and(
            eq(workspaceIntegrationResources.workspaceId, workspaceId),
            eq(workspaceIntegrationResources.provider, "github"),
            eq(workspaceIntegrationResources.resourceType, "repository"),
            eq(workspaceIntegrationResources.externalId, repository.binding.externalId),
            eq(workspaceIntegrations.externalId, repository.binding.connection.externalId),
          ),
        )
        .limit(1)
    : await baseQuery
        .where(
          and(
            eq(workspaceIntegrationResources.workspaceId, workspaceId),
            eq(workspaceIntegrationResources.provider, "github"),
            eq(workspaceIntegrationResources.resourceType, "repository"),
            eq(workspaceIntegrationResources.name, repository.fullName),
          ),
        )
        .limit(2);

  const usableRows = rows.filter(
    (row) => row.connectionStatus === "connected" && row.resourceStatus === "available",
  );
  if (!repository.binding && usableRows.length > 1) {
    throw new Error(
      `GitHub work repository ${repository.fullName} matches multiple workspace connections. Re-save the agent with a concrete repository binding.`,
    );
  }
  const row = usableRows[0] ?? rows[0];
  if (!row) {
    throw new Error(
      `GitHub work repository ${repository.fullName} is not available to this workspace.`,
    );
  }
  assertGitHubWorkRepositoryUsable(row, repository.fullName);

  return row;
}

function assertGitHubWorkRepositoryUsable(
  row: {
    integrationId: string;
    connectionLabel: string | null;
    connectionStatus: string;
    connectionStatusReason: string | null;
    resourceStatus: string;
    resourceStatusReason: string | null;
  },
  repositoryFullName: string,
) {
  const connectionLabel = row.connectionLabel ?? "GitHub";
  if (row.connectionStatus !== "connected") {
    const repair =
      row.connectionStatus === "needs_reauth"
        ? "Reconnect GitHub or update the agent repository mention."
        : "Refresh or reconnect GitHub before running this agent.";
    markObservedGitHubIntegrationStatus({
      integrationId: row.integrationId,
      status: row.connectionStatus === "needs_reauth" ? "needs_reauth" : "sync_failed",
      statusReason: row.connectionStatusReason ?? `GitHub connection ${connectionLabel} failed.`,
    });
    throw new Error(
      appendStatusReason(
        `GitHub connection ${connectionLabel} is ${formatStatus(row.connectionStatus)}. ${repair}`,
        row.connectionStatusReason,
      ),
    );
  }

  if (row.resourceStatus !== "available") {
    markObservedGitHubIntegrationStatus({
      integrationId: row.integrationId,
      status: "sync_failed",
      statusReason:
        row.resourceStatusReason ??
        `GitHub repository ${repositoryFullName} is ${formatStatus(row.resourceStatus)}.`,
    });
    throw new Error(
      appendStatusReason(
        `GitHub repository ${repositoryFullName} is no longer available to this workspace. Reconnect GitHub or update the agent repository mention.`,
        row.resourceStatusReason,
      ),
    );
  }
}

function markObservedGitHubIntegrationStatus(input: {
  integrationId: string;
  status: "needs_reauth" | "sync_failed";
  statusReason: string;
}) {
  void (async () => {
    await getDb()
      .update(workspaceIntegrations)
      .set({
        status: input.status,
        statusReason: truncateText(
          input.statusReason.replace(/\s+/g, " ").trim() ||
            "GitHub integration health check failed.",
          240,
        ),
        updatedAt: new Date(),
      })
      .where(eq(workspaceIntegrations.id, input.integrationId));
  })().catch(() => undefined);
}

function appendStatusReason(message: string, reason: string | null) {
  return reason?.trim() ? `${message} ${reason.trim()}` : message;
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ");
}

function loadPlatformAmpApiKey(env: RunnerEnv) {
  if (!env.ampApiKey) {
    throw new Error("AMP_API_KEY is required on the runner to use the AMP coding tool.");
  }
  return env.ampApiKey;
}

type AmpStreamSummary = {
  threadId: string | null;
  status: "success" | "error" | "unknown";
  result: string;
  error: string | null;
  durationMs: number | null;
  numTurns: number | null;
  permissionDenials: string[];
};

export function createAmpStreamAccumulator() {
  let buffer = "";
  let threadId: string | null = null;
  let status: AmpStreamSummary["status"] = "unknown";
  let result = "";
  let error: string | null = null;
  let plainOutput = "";
  let durationMs: number | null = null;
  let numTurns: number | null = null;
  let lastAssistantText = "";
  let permissionDenials: string[] = [];

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      plainOutput = appendAmpPlainOutput(plainOutput, line);
      return;
    }
    if (!isRecord(event)) return;

    const eventThreadId = readOptionalText(event.session_id);
    if (eventThreadId) threadId = eventThreadId;

    if (event.type === "assistant") {
      const message = isRecord(event.message) ? event.message : {};
      lastAssistantText = readAmpAssistantText(message) || lastAssistantText;
      return;
    }

    if (event.type !== "result") return;

    durationMs = readOptionalFiniteNumber(event.duration_ms) ?? durationMs;
    numTurns = readOptionalFiniteNumber(event.num_turns) ?? numTurns;
    permissionDenials = readStringArray(event.permission_denials);

    if (event.is_error === true || event.subtype !== "success") {
      status = "error";
      error = readOptionalText(event.error) ?? "Amp failed without an error message.";
      result = "";
      return;
    }

    status = "success";
    result = readOptionalText(event.result) ?? lastAssistantText;
    error = null;
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
    summary(input?: {
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
    }): AmpStreamSummary {
      const fallbackResult =
        result ||
        lastAssistantText ||
        compactAmpPlainOutput(plainOutput) ||
        compactAmpPlainOutput(input?.stdout) ||
        compactAmpPlainOutput(input?.stderr);
      const exitCode = input?.exitCode;
      const resolvedStatus =
        status !== "unknown" || typeof exitCode !== "number"
          ? status
          : exitCode === 0
            ? "success"
            : "error";
      const resolvedError =
        error ??
        (resolvedStatus === "error"
          ? fallbackResult || `Amp exited with code ${exitCode ?? "unknown"}.`
          : null);

      return {
        threadId,
        status: resolvedStatus,
        result: resolvedStatus === "error" ? result || lastAssistantText : fallbackResult,
        error: resolvedError,
        durationMs,
        numTurns,
        permissionDenials,
      };
    },
  };
}

function appendAmpPlainOutput(current: string, line: string) {
  const next = `${current}${line}\n`;
  return next.length > 24_000 ? next.slice(-24_000) : next;
}

function compactAmpPlainOutput(value: string | null | undefined) {
  return sanitizeAmpPlainOutput(value ?? "").trim();
}

function sanitizeAmpPlainOutput(value: string) {
  return value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function createAmpActivityFormatter() {
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

    const summary = summarizeAmpEvent(event);
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

function summarizeAmpEvent(event: Record<string, unknown>) {
  const type = readOptionalText(event.type);

  if (type === "system") {
    const subtype = readOptionalText(event.subtype);
    const threadId = readOptionalText(event.session_id);
    if (subtype === "init") {
      return threadId ? `Amp session ${threadId} started.` : "Amp session started.";
    }
    return "";
  }

  if (type === "assistant") {
    const message = isRecord(event.message) ? event.message : {};
    return readAmpAssistantActivity(message);
  }

  if (type === "result") {
    const durationMs = readOptionalFiniteNumber(event.duration_ms);
    const numTurns = readOptionalFiniteNumber(event.num_turns);
    if (event.is_error === true || event.subtype !== "success") {
      const error = readOptionalText(event.error);
      return error ? `Amp failed: ${error}` : "Amp failed.";
    }
    return `Amp completed${formatAmpDurationSuffix(durationMs, numTurns)}.`;
  }

  if (type === "tool_use" || type === "tool-call") {
    const name = readOptionalText(event.name) ?? readOptionalText(event.tool_name) ?? "tool";
    return `Amp is using ${formatAmpLabel(name)}${formatAmpInputSuffix(event.input)}.`;
  }

  if (type === "tool_result" || type === "tool-result") {
    const name = readOptionalText(event.name) ?? readOptionalText(event.tool_name);
    return name ? `Amp received ${formatAmpLabel(name)} result.` : "Amp received a tool result.";
  }

  return "";
}

function readAmpAssistantText(message: Record<string, unknown>) {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
}

function readAmpAssistantActivity(message: Record<string, unknown>) {
  const content = Array.isArray(message.content) ? message.content : [];
  const summaries: string[] = [];

  for (const part of content) {
    if (!isRecord(part)) continue;

    if (part.type === "text") {
      const text = readOptionalText(part.text);
      if (text) summaries.push(`Amp: ${compactWhitespace(text)}`);
      continue;
    }

    if (part.type === "tool_use" || part.type === "tool-call") {
      const name = readOptionalText(part.name) ?? readOptionalText(part.toolName) ?? "tool";
      summaries.push(`Amp is using ${formatAmpLabel(name)}${formatAmpInputSuffix(part.input)}.`);
    }
  }

  return summaries.length > 0 ? truncateText(summaries.join("\n"), 1000) : "";
}

function formatAmpInputSuffix(value: unknown) {
  const preview = compactWhitespace(formatCompactValue(value));
  return preview ? `: ${truncateText(preview, 180)}` : "";
}

function formatCompactValue(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatAmpDurationSuffix(durationMs: number | null | undefined, numTurns: number | null) {
  const parts: string[] = [];
  if (durationMs !== null && durationMs !== undefined) parts.push(formatDurationMs(durationMs));
  if (numTurns !== null && numTurns !== undefined) {
    parts.push(`${numTurns} ${numTurns === 1 ? "turn" : "turns"}`);
  }
  return parts.length > 0 ? ` in ${parts.join(", ")}` : "";
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatAmpLabel(value: string) {
  return value.replace(/[_-]+/g, " ").trim() || "tool";
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function readCurrentGitBranch(sandbox: SandboxHandle, workRoot: string) {
  const result = await sandbox.commands.run(
    `cd ${shellQuote(workRoot)} && git branch --show-current`,
    { timeoutMs: 30_000 },
  );
  const branch = String(result.stdout ?? "").trim();
  return branch || null;
}

async function readLocalCommitCount(
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

async function readPullRequestUrlForBranch(
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

function normalizeCommitMessage(value: string) {
  const firstLine = value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine || "Apply AMP changes";
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

function githubRemoteUrl(repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error("Invalid GitHub repository name for AMP push.");
  }

  return `https://github.com/${repositoryFullName}.git`;
}

function gitAuthExtraHeaderArg() {
  return `-c http.extraheader="$${GITHUB_AUTH_HEADER_ENV}"`;
}

function gitAuthHeader(token: string) {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  )}`;
}

function safePathSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-") || "amp";
}

export async function readSandboxBrainSnapshot(sandbox: SandboxHandle, workdir: string) {
  const result = await sandbox.commands.run(
    `cd ${shellQuote(workdir)} && if [ -d brain ]; then find brain -type f -printf '%P\t%s\t%T@\\n' | sort; fi`,
    { timeoutMs: 30_000 },
  );
  return String(result.stdout ?? "");
}

function formatAmpDiffStat(stat: unknown, status: unknown) {
  const statText = String(stat ?? "").trim();
  const statusText = String(status ?? "").trim();
  if (!statusText) return statText;
  if (!statText) return statusText;
  return `${statText}\n\n${statusText}`;
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

function readOptionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function readOptionalFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
