import { type AgentConfig, repositoryIdForFullName, shellQuote } from "@opencompany/agent-runtime";
import type { AgentGitHubRepositoryConfig } from "@opencompany/agent-runtime/types";
import {
  agentSessionArtifacts,
  workspaceIntegrationResources,
  workspaceIntegrations,
} from "@opencompany/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { createDraftPullRequest, getGitHubWorkInstallationToken } from "./github";
import type { HostedToolUsage } from "./hosted-tools";
import { isRunLeaseCurrent, requireLeaseWrite } from "./lease-writes";
import { cloneGitHubRepositoryIntoWorkdir, type SandboxHandle, sandboxLayout } from "./sandbox";

const GITHUB_AUTH_HEADER_ENV = "GITHUB_AUTH_HEADER";
const AMP_API_BASE_URL = "https://ampcode.com";
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
  if (!ampTool || ampTool.id !== "amp") {
    throw new Error("The amp_coder tool is not enabled for this agent.");
  }
  const target = resolveAmpTargetRepository({
    repositories: input.agentConfig.integrations.github.repositories,
    requestedRepository: typeof args.repository === "string" ? args.repository : undefined,
    allRepositories: input.agentConfig.integrations.github.allRepositories === true,
  });

  const ampApiKey = loadPlatformAmpApiKey(input.env);
  const { repository, installationId } = await resolveAmpWorkspaceRepository(
    input.workspaceId,
    target,
  );
  const githubToken = await getGitHubWorkInstallationToken({
    installationId,
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
    repositoryFullName: repository.fullName,
    toolCallId: input.toolCallId,
  });
  const redactAmpOutput = createKnownSecretRedactor([ampApiKey, githubToken, githubAuthHeader]);
  const layout = sandboxLayout(input.workdir);
  // Clone the target repository into work/ on demand. This is idempotent: if work/
  // is already a checkout of the repository it just refreshes the authenticated
  // remote, otherwise it clones fresh.
  await cloneGitHubRepositoryIntoWorkdir({
    sandbox: input.sandbox,
    workdir: layout.workRoot,
    repositoryFullName: repository.fullName,
    defaultBranch: repository.defaultBranch,
    githubToken,
  });
  await input.sandbox.commands.run(
    `git config --global --add safe.directory ${shellQuote(layout.workRoot)}`,
  );
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
      installationId,
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

  const ampUsage = ampSummary.usage;
  const costUsdMicros = ampSummary.threadId
    ? ((await fetchAmpThreadCost(ampSummary.threadId, ampApiKey)) ?? 0)
    : 0;

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
    ...(ampUsage
      ? {
          usage: {
            provider: "amp",
            operation: "session",
            costUsdMicros,
            rawUsage: {
              input_tokens: ampUsage.input_tokens,
              output_tokens: ampUsage.output_tokens,
              ...(ampUsage.cache_creation_input_tokens !== undefined
                ? { cache_creation_input_tokens: ampUsage.cache_creation_input_tokens }
                : {}),
              ...(ampUsage.cache_read_input_tokens !== undefined
                ? { cache_read_input_tokens: ampUsage.cache_read_input_tokens }
                : {}),
            },
          } satisfies HostedToolUsage,
        }
      : {}),
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
  repositoryFullName?: string;
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
}) {
  if (input.currentBranch && input.currentBranch !== input.defaultBranch) {
    return input.currentBranch;
  }

  return `opencompany/amp-${input.sessionId.slice(-8)}-${input.now}`;
}

export type AmpTargetRepository =
  | { kind: "attached"; repository: AgentGitHubRepositoryConfig }
  | { kind: "workspace"; fullName: string };

export function resolveAmpTargetRepository(input: {
  repositories: AgentGitHubRepositoryConfig[];
  requestedRepository?: string | undefined;
  // Live `@github` all-repositories scope: a requested owner/repo that isn't attached
  // resolves against the workspace's GitHub connection instead of failing.
  allRepositories?: boolean;
}): AmpTargetRepository {
  const { repositories } = input;
  const allRepositories = input.allRepositories === true;
  if (repositories.length === 0 && !allRepositories) {
    throw new Error(
      "amp_coder needs at least one GitHub repository attached to the agent. Add a repository, then try again.",
    );
  }

  const requested = input.requestedRepository?.trim();
  if (requested) {
    const requestedLower = requested.toLowerCase();
    const match = repositories.find(
      (repository) =>
        repository.id === requested || repository.fullName.toLowerCase() === requestedLower,
    );
    if (match) return { kind: "attached", repository: match };
    if (allRepositories && isGitHubRepositoryFullName(requested)) {
      return { kind: "workspace", fullName: requested };
    }
    throw new Error(
      allRepositories
        ? `Requested repository "${requested}" is not a valid owner/repo. Pass the repository as owner/repo.`
        : `Requested repository "${requested}" is not attached to this agent. Attached repositories: ${repositories
            .map((repository) => repository.fullName)
            .join(", ")}.`,
    );
  }

  if (repositories.length === 1) return { kind: "attached", repository: repositories[0]! };

  if (repositories.length === 0) {
    // allRepositories with nothing attached: there is no sensible default repo.
    throw new Error(
      "amp_coder needs the repository argument (owner/repo): this agent has integration-wide GitHub access with no default repository attached.",
    );
  }

  throw new Error(
    `More than one repository is attached. Set the repository argument (owner/repo or id) to choose one. Attached repositories: ${repositories
      .map((repository) => repository.fullName)
      .join(", ")}.`,
  );
}

// Resolve an amp target to a concrete repository + installation. Attached targets keep their
// saved config (binding-aware); workspace targets (`@github` all-repositories scope) resolve
// live against the workspace's synced GitHub resources, picking up the real default branch.
async function resolveAmpWorkspaceRepository(
  workspaceId: string,
  target: AmpTargetRepository,
): Promise<{ repository: AgentGitHubRepositoryConfig; installationId: string }> {
  if (target.kind === "attached") {
    const integrationRepository = await loadGitHubWorkRepository(workspaceId, target.repository);
    return { repository: target.repository, installationId: integrationRepository.installationId };
  }

  const resolved = await loadGitHubWorkRepositoryByFullName(workspaceId, target.fullName);
  if (!resolved) {
    throw new Error(
      `GitHub work repository ${target.fullName} is not available to this workspace. Reconnect GitHub or grant the installation access to it.`,
    );
  }
  return resolved;
}

function isGitHubRepositoryFullName(value: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

/**
 * Resolve the GitHub App installation for each attached repository, preserving
 * order. A failing integration (e.g. needs-reauth) propagates so the caller can
 * surface it — an attached-but-broken repository should be fixed, not silently
 * ignored. A single installation token cannot span multiple installations, so
 * callers that need one token should scope it to the repos of one installation
 * (typically the first attached repo's installation).
 */
export async function resolveAttachedRepositoryInstallations(
  workspaceId: string,
  repositories: AgentGitHubRepositoryConfig[],
): Promise<Array<{ fullName: string; installationId: string }>> {
  const resolved: Array<{ fullName: string; installationId: string }> = [];
  for (const repository of repositories) {
    const integrationRepository = await loadGitHubWorkRepository(workspaceId, repository);
    resolved.push({
      fullName: repository.fullName,
      installationId: integrationRepository.installationId,
    });
  }
  return resolved;
}

export async function loadGitHubWorkRepository(
  workspaceId: string,
  repository: AgentGitHubRepositoryConfig,
) {
  const row = await loadGitHubWorkRepositoryRow(workspaceId, repository);
  if (!row) {
    throw new Error(
      `GitHub work repository ${repository.fullName} is not available to this workspace.`,
    );
  }
  return row;
}

/**
 * Live lookup for integration-wide (`@github` all-repositories) targets: resolve any
 * owner/repo the workspace's GitHub connection can reach without it being attached to the
 * agent, picking up the synced default branch. Returns null when the repository is unknown
 * to the workspace (so callers can fall back, e.g. opencode's public-clone path); a
 * known-but-unusable repository still throws the actionable status errors.
 */
export async function loadGitHubWorkRepositoryByFullName(
  workspaceId: string,
  fullName: string,
): Promise<{ repository: AgentGitHubRepositoryConfig; installationId: string } | null> {
  const row = await loadGitHubWorkRepositoryRow(workspaceId, {
    id: repositoryIdForFullName(fullName),
    fullName,
    defaultBranch: "main",
  });
  if (!row) return null;

  return {
    repository: {
      id: repositoryIdForFullName(row.fullName),
      fullName: row.fullName,
      defaultBranch: row.defaultBranch,
    },
    installationId: row.installationId,
  };
}

/**
 * The workspace's connected GitHub installation, for integration-wide (`@github`) ambient
 * auth. With multiple installations the first connected one wins — a single installation
 * token cannot span installations; amp/opencode resolve installations per repository, so the
 * coding tools still work across installations.
 */
export async function loadConnectedGitHubInstallation(
  workspaceId: string,
): Promise<{ installationId: string; connectionLabel: string | null } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      installationId: workspaceIntegrations.externalId,
      connectionLabel: workspaceIntegrations.connectionLabel,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, "github"),
        eq(workspaceIntegrations.status, "connected"),
      ),
    )
    .orderBy(asc(workspaceIntegrations.createdAt))
    .limit(1);

  return row ?? null;
}

async function loadGitHubWorkRepositoryRow(
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
      metadata: workspaceIntegrationResources.metadata,
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
  if (!row) return null;
  assertGitHubWorkRepositoryUsable(row, repository.fullName);

  return {
    ...row,
    defaultBranch: readResourceDefaultBranch(row.metadata),
  };
}

function readResourceDefaultBranch(metadata: unknown) {
  const defaultBranch =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).defaultBranch
      : undefined;
  return typeof defaultBranch === "string" && defaultBranch.trim() ? defaultBranch.trim() : "main";
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

/**
 * Fetch the real USD cost of an AMP thread from the AMP Enterprise API.
 * Returns cost in USD micros (1 USD = 1_000_000 micros), or null if the cost
 * cannot be retrieved (non-Enterprise account, auth failure, network error, etc.).
 */
export async function fetchAmpThreadCost(
  threadId: string,
  apiKey: string,
  baseUrl = AMP_API_BASE_URL,
): Promise<number | null> {
  try {
    const url = `${baseUrl}/api/v2/threads/${encodeURIComponent(threadId)}/usage`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    const usage = body.usage;
    if (typeof usage !== "number" || !Number.isFinite(usage) || usage < 0) return null;
    return Math.round(usage * 1_000_000);
  } catch {
    return null;
  }
}

// AMP stream-json uses Anthropic-style snake_case token field names.
interface AmpUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

type AmpStreamSummary = {
  threadId: string | null;
  status: "success" | "error" | "unknown";
  result: string;
  error: string | null;
  durationMs: number | null;
  numTurns: number | null;
  permissionDenials: string[];
  usage: AmpUsage | null;
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
  let accumulatedUsage: AmpUsage = { input_tokens: 0, output_tokens: 0 };
  let hasAccumulatedUsage = false;
  let resultUsage: AmpUsage | null = null;

  function accumulateMessageUsage(message: Record<string, unknown>) {
    const parsed = readEventUsage({ usage: message.usage });
    if (!parsed) return;
    hasAccumulatedUsage = true;
    accumulatedUsage.input_tokens += parsed.input_tokens;
    accumulatedUsage.output_tokens += parsed.output_tokens;
    if (parsed.cache_creation_input_tokens !== undefined) {
      accumulatedUsage.cache_creation_input_tokens =
        (accumulatedUsage.cache_creation_input_tokens ?? 0) + parsed.cache_creation_input_tokens;
    }
    if (parsed.cache_read_input_tokens !== undefined) {
      accumulatedUsage.cache_read_input_tokens =
        (accumulatedUsage.cache_read_input_tokens ?? 0) + parsed.cache_read_input_tokens;
    }
  }

  function readEventUsage(event: Record<string, unknown>): AmpUsage | null {
    const u = isRecord(event.usage) ? event.usage : null;
    if (!u) return null;
    const inputTokens = readOptionalFiniteNumber(u.input_tokens);
    const outputTokens = readOptionalFiniteNumber(u.output_tokens);
    const cacheCreation = readOptionalFiniteNumber(u.cache_creation_input_tokens);
    const cacheRead = readOptionalFiniteNumber(u.cache_read_input_tokens);
    // Reject usage that conveys nothing billable: no positive in/out tokens AND no cache fields.
    // Cache-only events (no input/output keys) and zero-with-cache events are kept.
    const hasTokens = (inputTokens ?? 0) > 0 || (outputTokens ?? 0) > 0;
    const hasCache = cacheCreation !== null || cacheRead !== null;
    if (!hasTokens && !hasCache) return null;
    const usage: AmpUsage = {
      input_tokens: inputTokens ?? 0,
      output_tokens: outputTokens ?? 0,
    };
    if (cacheCreation !== null) usage.cache_creation_input_tokens = cacheCreation;
    if (cacheRead !== null) usage.cache_read_input_tokens = cacheRead;
    return usage;
  }

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
      accumulateMessageUsage(message);
      return;
    }

    if (event.type !== "result") return;

    durationMs = readOptionalFiniteNumber(event.duration_ms) ?? durationMs;
    numTurns = readOptionalFiniteNumber(event.num_turns) ?? numTurns;
    permissionDenials = readStringArray(event.permission_denials);
    resultUsage = readEventUsage(event);

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
      const finalUsage = resultUsage ?? (hasAccumulatedUsage ? accumulatedUsage : null);

      return {
        threadId,
        status: resolvedStatus,
        result: resolvedStatus === "error" ? result || lastAssistantText : fallbackResult,
        error: resolvedError,
        durationMs,
        numTurns,
        permissionDenials,
        usage: finalUsage,
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
