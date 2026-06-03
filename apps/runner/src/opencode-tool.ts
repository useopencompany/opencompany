import { AGENT_MODEL_CATALOG, type AgentConfig, shellQuote } from "@opencompany/agent-runtime";
import type { AgentGitHubRepositoryConfig, AgentModelId } from "@opencompany/agent-runtime/types";
import { agentSessionArtifacts } from "@opencompany/db/schema";
import { loadGitHubWorkRepository } from "./amp-tool";
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
  safePathSegment,
  selectPublishBranch,
  truncateText,
} from "./coding-agent-shared";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { createDraftPullRequest, getGitHubWorkInstallationToken } from "./github";
import type { HostedToolUsage } from "./hosted-tools";
import { isRunLeaseCurrent, requireLeaseWrite } from "./lease-writes";
import {
  cloneGitHubRepositoryIntoWorkdir,
  githubRemoteMatches,
  type SandboxHandle,
  sandboxLayout,
} from "./sandbox";

// opencode is configured to reach the platform's Vercel AI Gateway through a
// custom OpenAI-compatible provider named "gateway". The gateway model id (e.g.
// "anthropic/claude-sonnet-4.6") is reused verbatim, so the opencode model
// string is `gateway/<modelId>`.
const OPENCODE_PROVIDER_ID = "gateway";
const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_OPENCODE_MODEL: AgentModelId = "anthropic/claude-sonnet-4.6";
const SUPPORTED_MODEL_IDS = new Set<string>(AGENT_MODEL_CATALOG.map((model) => model.id));
// Where the opencode installer drops the binary. Prepended to PATH for the run so
// a freshly installed opencode is found without re-sourcing the shell profile.
const OPENCODE_BIN_PATH = '"$HOME/.opencode/bin"';

type OpencodeTarget =
  | {
      kind: "attached";
      repository: AgentGitHubRepositoryConfig;
    }
  | {
      kind: "public";
      repositoryFullName: string;
    };

// Make opencode available regardless of the sandbox image. When the coding
// template already ships opencode (e.g. baked in, or an e2b opencode-based image)
// this is a fast no-op; otherwise it installs the CLI on demand. Keeping this here
// means the tool works on the current template without a rebuild.
async function ensureOpencodeInstalled(sandbox: SandboxHandle) {
  const check = await sandbox.commands.run(
    `command -v opencode || test -x "$HOME/.opencode/bin/opencode" && echo found || true`,
    { timeoutMs: 30_000 },
  );
  if (String(check.stdout ?? "").trim()) return;
  await sandbox.commands.run("curl -fsSL https://opencode.ai/install | bash", {
    timeoutMs: 180_000,
  });
}

export async function runOpencodeCoderTool(input: {
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
  if (!task) throw new Error("opencode task is required.");
  const requestedSessionId =
    typeof args.opencodeSessionId === "string" && args.opencodeSessionId.trim()
      ? args.opencodeSessionId.trim()
      : null;
  const modelId = resolveOpencodeModel(args.model);

  const opencodeTool = input.agentConfig.tools.find((tool) => tool.id === "opencode");
  if (!opencodeTool || opencodeTool.id !== "opencode") {
    throw new Error("The opencode_coder tool is not enabled for this agent.");
  }
  const target = resolveOpencodeTarget({
    repositories: input.agentConfig.integrations.github.repositories,
    requestedRepository: typeof args.repository === "string" ? args.repository : undefined,
  });

  const gatewayApiKey = input.env.vercelAiGatewayApiKey;
  const layout = sandboxLayout(input.workdir);
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
        "GitHub App credentials are required to run opencode in a GitHub work repository.",
      );
    }
    githubAuthHeader = gitAuthHeader(githubToken);

    // Clone the target repository into work/ on demand (idempotent — refreshes the
    // authenticated remote when work/ is already a checkout of the repository).
    await cloneGitHubRepositoryIntoWorkdir({
      sandbox: input.sandbox,
      workdir: layout.workRoot,
      repositoryFullName,
      defaultBranch,
      githubToken,
    });
  } else {
    defaultBranch = await resolvePublicGitHubDefaultBranch(input.sandbox, repositoryFullName);
    await clonePublicGitHubRepositoryIntoWorkdir({
      sandbox: input.sandbox,
      workdir: layout.workRoot,
      repositoryFullName,
      defaultBranch,
    });
  }

  const redact = createKnownSecretRedactor([gatewayApiKey, githubToken, githubAuthHeader]);
  await input.sandbox.commands.run(
    `git config --global --add safe.directory ${shellQuote(layout.workRoot)}`,
  );

  // Write an opencode config pointing at the platform AI gateway so opencode uses
  // the same routed credentials as the rest of the runner (no raw provider keys
  // in the sandbox, no interactive /connect). The config lives outside work/ so it
  // never shows up in the repository diff.
  const configDir = `/tmp/opencompany-opencode-${safePathSegment(input.toolCallId)}`;
  const configPath = `${configDir}/opencode.json`;
  await input.sandbox.commands.run(`mkdir -p ${shellQuote(configDir)}`, { timeoutMs: 30_000 });
  await input.sandbox.files.write(configPath, buildOpencodeConfig(modelId));

  const opencodeEnv = {
    OPENCODE_CONFIG: configPath,
    VERCEL_AI_GATEWAY_API_KEY: gatewayApiKey,
    ...(target.kind === "attached" && githubToken && githubAuthHeader
      ? buildGitHubCommandEnv({
          githubAuthHeader,
          githubToken,
          repositoryFullName,
          toolCallId: input.toolCallId,
        })
      : {}),
  };

  await ensureOpencodeInstalled(input.sandbox);

  const stream = createOpencodeStreamAccumulator();
  const result = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && export PATH=${OPENCODE_BIN_PATH}:"$PATH" && ${buildOpencodeCommand(
      {
        task,
        model: `${OPENCODE_PROVIDER_ID}/${modelId}`,
        sessionId: requestedSessionId,
      },
    )}`,
    {
      envs: opencodeEnv,
      timeoutMs: 600_000,
      onStdout: async (data: string) => {
        const redacted = redact(data);
        const activity = stream.push(redacted);
        if (activity) await input.onOutput?.(activity);
      },
      onStderr: async (data: string) => {
        await input.onOutput?.(redact(data));
      },
    },
  );
  stream.finish();
  const summary = stream.summary({
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    stdout: redact(String(result.stdout ?? "")),
    stderr: redact(String(result.stderr ?? "")),
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
    defaultBranch,
  );
  let branchName: string | null = null;
  let pullRequestUrl: string | null = null;

  if (args.createPullRequest === true && target.kind === "public") {
    pullRequestSkippedReason = "public_repository_without_workspace_installation";
  }

  if (args.createPullRequest === true && target.kind === "attached") {
    if (!opencodeTool.prCapable) {
      throw new Error("opencode is not configured for pull request creation.");
    }
    const existingPrUrl = await readPullRequestUrlForBranch(
      input.sandbox,
      layout.workRoot,
      currentBranch,
      opencodeEnv,
    );
    if (existingPrUrl) {
      branchName = currentBranch;
      pullRequestUrl = existingPrUrl;
    }
  }

  if (
    args.createPullRequest === true &&
    target.kind === "attached" &&
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
      prefix: "opencode",
    });
    const commitMessage = normalizeCommitMessage(
      typeof args.pullRequestTitle === "string" ? args.pullRequestTitle : task,
      "Apply opencode changes",
    );
    const prepareCommands = [
      `cd ${shellQuote(layout.workRoot)}`,
      `git config user.name ${shellQuote("OpenCompany Agent")}`,
      `git config user.email ${shellQuote("agents@opencompany.ai")}`,
      ...(branchName === currentBranch ? [] : [`git checkout -b ${shellQuote(branchName)}`]),
      ...(hasDiff ? ["git add -A", `git commit -m ${shellQuote(commitMessage)}`] : []),
      `git remote set-url origin ${shellQuote(githubRemoteUrl(repositoryFullName))}`,
    ];
    await input.sandbox.commands.run(prepareCommands.join(" && "), { timeoutMs: 120_000 });
    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    await input.sandbox.commands.run(
      `cd ${shellQuote(layout.workRoot)} && git ${gitAuthExtraHeaderArg()} push origin ${shellQuote(
        branchName,
      )}`,
      { envs: { [GITHUB_AUTH_HEADER_ENV]: githubAuthHeader ?? "" }, timeoutMs: 180_000 },
    );
    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    if (!integrationRepository) {
      throw new Error(
        "Attached repository metadata is required to create an opencode pull request.",
      );
    }
    const pr = await createDraftPullRequest({
      installationId: integrationRepository.installationId,
      repositoryFullName,
      title: commitMessage,
      head: branchName,
      base: defaultBranch,
      body: ["Created by OpenCompany opencode.", "", `Task: ${redact(task)}`].join("\n"),
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
      toolName: "opencode_coder",
      kind: "opencode_run",
      title: task,
      url: pullRequestUrl,
      externalId: summary.sessionId,
      repositoryFullName,
      branchName,
      diffStat: truncateText(redact(formatDiffStat(diffStat.stdout, diffStatus.stdout)), 4000),
      diffPreview: truncateText(redact(String(diffPreview.stdout ?? "")), 24_000),
      metadata: {
        continuedFromOpencodeSessionId: requestedSessionId,
        repositoryTarget: target.kind,
        model: modelId,
        opencodeStatus: summary.status,
        opencodeError: summary.error ? redact(summary.error) : null,
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        pullRequestSkippedReason,
      },
    });

  const usage = summary.usage;
  return {
    repository: repositoryFullName,
    repositoryTarget: target.kind,
    model: modelId,
    opencodeSessionId: summary.sessionId,
    continuedFromOpencodeSessionId: requestedSessionId,
    opencodeStatus: summary.status,
    opencodeResult: truncateText(redact(summary.result), 24_000),
    opencodeError: summary.error ? redact(summary.error) : null,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    diffStat: truncateText(redact(formatDiffStat(diffStat.stdout, diffStatus.stdout)), 4000),
    diffPreview: truncateText(redact(String(diffPreview.stdout ?? "")), 24_000),
    branchName,
    pullRequestUrl,
    pullRequestSkippedReason,
    ...(usage
      ? {
          usage: {
            provider: "opencode",
            operation: "session",
            costUsdMicros: summary.costUsdMicros ?? 0,
            rawUsage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              ...(usage.cache_creation_input_tokens !== undefined
                ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
                : {}),
              ...(usage.cache_read_input_tokens !== undefined
                ? { cache_read_input_tokens: usage.cache_read_input_tokens }
                : {}),
            },
          } satisfies HostedToolUsage,
        }
      : {}),
  };
}

export function resolveOpencodeModel(value: unknown): AgentModelId {
  if (value == null || value === "") return DEFAULT_OPENCODE_MODEL;
  if (typeof value !== "string") {
    throw new Error("opencode model must be a string.");
  }
  const model = value.trim();
  if (SUPPORTED_MODEL_IDS.has(model)) return model as AgentModelId;
  throw new Error(
    `Unsupported opencode model "${model}". Use a supported provider/model id such as ${DEFAULT_OPENCODE_MODEL}.`,
  );
}

export function resolveOpencodeTarget(input: {
  repositories: AgentGitHubRepositoryConfig[];
  requestedRepository?: string | undefined;
}): OpencodeTarget {
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
      return { kind: "public", repositoryFullName: publicRepositoryFullName };
    }

    throw new Error(
      `Requested repository "${requested}" is not an attached repository or a supported public GitHub repository. Use an attached repository id/full name, public owner/repo, or https://github.com/owner/repo URL.`,
    );
  }

  if (input.repositories.length === 1) {
    return { kind: "attached", repository: input.repositories[0]! };
  }

  if (input.repositories.length > 1) {
    throw new Error(
      `More than one repository is attached. Set the repository argument (owner/repo, id, or public GitHub URL) to choose one. Attached repositories: ${input.repositories
        .map((repository) => repository.fullName)
        .join(", ")}.`,
    );
  }

  throw new Error(
    "opencode_coder needs a repository argument when no GitHub repository is attached. Use a public GitHub owner/repo or https://github.com/owner/repo URL.",
  );
}

export function parsePublicGitHubRepository(value: string): string | null {
  const input = value.trim();
  if (!input || input.startsWith("git@") || input.startsWith("ssh://")) return null;

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    return normalizeGitHubRepositoryFullName(owner, repo);
  }

  const parts = input.split("/");
  if (parts.length !== 2) return null;
  return normalizeGitHubRepositoryFullName(parts[0], parts[1]);
}

export function buildPublicGitHubDefaultBranchCommand(repositoryFullName: string) {
  return `git ls-remote --symref ${shellQuote(
    githubRemoteUrl(repositoryFullName),
  )} HEAD | awk '/^ref:/ { sub("refs\\/heads\\/", "", $2); print $2; exit }'`;
}

export async function resolvePublicGitHubDefaultBranch(
  sandbox: SandboxHandle,
  repositoryFullName: string,
) {
  const result = await sandbox.commands.run(
    buildPublicGitHubDefaultBranchCommand(repositoryFullName),
    {
      timeoutMs: 60_000,
    },
  );
  const branch = String(result.stdout ?? "").trim();
  if (!branch) {
    throw new Error(
      `Could not determine the default branch for public GitHub repository ${repositoryFullName}.`,
    );
  }
  return branch;
}

export function buildPublicGitHubCloneCommand(input: {
  workdir: string;
  repositoryFullName: string;
  defaultBranch: string;
}) {
  return [
    `rm -rf ${shellQuote(input.workdir)}`,
    `git clone --depth 1 --branch ${shellQuote(input.defaultBranch)} ${shellQuote(
      githubRemoteUrl(input.repositoryFullName),
    )} ${shellQuote(input.workdir)}`,
  ].join(" && ");
}

export async function clonePublicGitHubRepositoryIntoWorkdir(input: {
  sandbox: SandboxHandle;
  workdir: string;
  repositoryFullName: string;
  defaultBranch: string;
}) {
  const origin = await input.sandbox.commands.run(
    [
      `if [ -d ${shellQuote(`${input.workdir}/.git`)} ]; then`,
      `  cd ${shellQuote(input.workdir)} && git remote get-url origin 2>/dev/null || true;`,
      "else",
      "  echo __opencompany_missing_git__;",
      "fi;",
    ].join("\n"),
    { timeoutMs: 30_000 },
  );
  const currentOrigin = String(origin.stdout ?? "").trim();
  const cloneUrl = githubRemoteUrl(input.repositoryFullName);
  if (githubRemoteMatches(currentOrigin, input.repositoryFullName)) {
    await input.sandbox.commands.run(
      `cd ${shellQuote(input.workdir)} && git remote set-url origin ${shellQuote(cloneUrl)}`,
      { timeoutMs: 30_000 },
    );
    return;
  }

  await input.sandbox.commands.run(buildPublicGitHubCloneCommand(input), { timeoutMs: 120_000 });
}

function normalizeGitHubRepositoryFullName(
  owner: string | undefined,
  repository: string | undefined,
) {
  const repo = repository?.endsWith(".git") ? repository.slice(0, -4) : repository;
  if (!owner || !repo) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return `${owner}/${repo}`;
}

export function buildOpencodeCommand(input: {
  task: string;
  model: string;
  sessionId?: string | null;
}) {
  const parts = ["opencode", "run", "--format", "json", "--model", shellQuote(input.model)];
  const sessionId = input.sessionId?.trim();
  if (sessionId) {
    parts.push("--session", shellQuote(sessionId));
  }
  // Auto-approve permission prompts: the E2B sandbox is the isolation boundary,
  // mirroring how amp runs with --dangerously-allow-all.
  parts.push("--dangerously-skip-permissions");
  parts.push(shellQuote(input.task));
  return parts.join(" ");
}

export function buildOpencodeConfig(modelId: string) {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [OPENCODE_PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Vercel AI Gateway",
          options: {
            baseURL: VERCEL_AI_GATEWAY_BASE_URL,
            apiKey: "{env:VERCEL_AI_GATEWAY_API_KEY}",
          },
          models: { [modelId]: { name: modelId } },
        },
      },
      model: `${OPENCODE_PROVIDER_ID}/${modelId}`,
    },
    null,
    2,
  )}\n`;
}

// opencode token usage uses the same Anthropic-style snake_case names the rest of
// the runner records.
interface OpencodeUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

type OpencodeStreamSummary = {
  sessionId: string | null;
  status: "success" | "error" | "unknown";
  result: string;
  error: string | null;
  usage: OpencodeUsage | null;
  costUsdMicros: number | null;
};

/**
 * Best-effort parser for `opencode run --format json` output. opencode emits
 * newline-delimited JSON events whose exact shape can shift across versions, so we
 * defensively scan each event for a session id, assistant text, token usage,
 * cost, and errors rather than binding to one schema. Anything unparsed falls back
 * to the raw stdout captured by summary().
 */
export function createOpencodeStreamAccumulator() {
  let buffer = "";
  let sessionId: string | null = null;
  let resultText = "";
  let error: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let sawTokens = false;
  let costUsd = 0;
  let sawCost = false;

  function ingestEvent(event: unknown): string | null {
    if (!isRecord(event)) return null;

    const eventSessionId = firstString(
      event.sessionID,
      event.sessionId,
      isRecord(event.session) ? event.session.id : undefined,
      isRecord(event.info) ? (event.info as Record<string, unknown>).sessionID : undefined,
    );
    if (eventSessionId && !sessionId) sessionId = eventSessionId;

    const typeValue = typeof event.type === "string" ? event.type : "";
    const part = isRecord(event.part) ? event.part : null;
    const partType = part && typeof part.type === "string" ? part.type : "";

    let activity: string | null = null;
    if (typeValue.includes("text") || partType === "text") {
      const text = firstString(event.text, part?.text);
      if (text) {
        resultText += text;
        activity = compactActivity(`opencode: ${text}`);
      }
    } else if (partType === "tool" || typeValue.includes("tool")) {
      const toolName = firstString(
        event.tool,
        part?.tool,
        isRecord(part?.state) ? (part?.state as Record<string, unknown>).title : undefined,
      );
      if (toolName) activity = compactActivity(`opencode tool: ${toolName}`);
    }

    const errorText = firstString(
      event.error,
      isRecord(event.error) ? (event.error as Record<string, unknown>).message : undefined,
    );
    if (errorText) error = errorText;

    accumulateTokens(findRecord(event, "tokens") ?? findRecord(event, "usage"));
    const cost = findNumber(event, "cost");
    if (cost != null) {
      costUsd += cost;
      sawCost = true;
    }

    return activity;
  }

  function accumulateTokens(tokens: Record<string, unknown> | null) {
    if (!tokens) return;
    const input = numberFrom(tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens);
    const output = numberFrom(tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens);
    const cache = isRecord(tokens.cache) ? tokens.cache : null;
    const cacheRead = numberFrom(cache?.read ?? tokens.cache_read_input_tokens);
    const cacheWrite = numberFrom(cache?.write ?? tokens.cache_creation_input_tokens);
    if (input != null) {
      inputTokens += input;
      sawTokens = true;
    }
    if (output != null) {
      outputTokens += output;
      sawTokens = true;
    }
    if (cacheRead != null) {
      cacheReadTokens += cacheRead;
      sawTokens = true;
    }
    if (cacheWrite != null) {
      cacheWriteTokens += cacheWrite;
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
    summary(input: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }): OpencodeStreamSummary {
      const status: OpencodeStreamSummary["status"] = error
        ? "error"
        : input.exitCode === 0
          ? "success"
          : input.exitCode == null
            ? "unknown"
            : "error";
      const result = resultText.trim() || input.stdout.trim();
      const resolvedError =
        error ?? (status === "error" && input.stderr.trim() ? input.stderr.trim() : null);
      const usage: OpencodeUsage | null = sawTokens
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
        result,
        error: resolvedError,
        usage,
        costUsdMicros: sawCost ? Math.round(costUsd * 1_000_000) : null,
      };
    },
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findRecord(event: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (isRecord(event[key])) return event[key] as Record<string, unknown>;
  if (isRecord(event.info) && isRecord((event.info as Record<string, unknown>)[key])) {
    return (event.info as Record<string, unknown>)[key] as Record<string, unknown>;
  }
  return null;
}

function findNumber(event: Record<string, unknown>, key: string): number | null {
  const direct = numberFrom(event[key]);
  if (direct != null) return direct;
  if (isRecord(event.info)) return numberFrom((event.info as Record<string, unknown>)[key]);
  return null;
}

function compactActivity(value: string) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}
