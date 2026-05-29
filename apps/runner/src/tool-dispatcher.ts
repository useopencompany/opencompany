import {
  type AgentConfig,
  newAgentSessionMessageId,
  RUNTIME_TOOL_DEFINITIONS,
  type RuntimeToolDefinition,
  type RuntimeToolName,
} from "@opencompany/agent-runtime";
import type { WorkspaceRepository } from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
import { jsonSchema, type ToolSet, tool } from "ai";
import {
  buildGitHubCommandEnv,
  createKnownSecretRedactor,
  loadGitHubWorkRepository,
  readSandboxBrainSnapshot,
  runAmpCoderTool,
} from "./amp-tool";
import { syncBrainFromSandbox } from "./brain";
import type { RunnerEnv } from "./env";
import { getGitHubWorkInstallationToken } from "./github";
import {
  executeHostedTool,
  getHostedToolFailureContext,
  type HostedToolUsage,
  MissingEnvError,
} from "./hosted-tools";
import {
  appendRuntimeEventForLease,
  insertToolMessageForLease,
  requireLeaseWrite,
  StaleRunLeaseError,
} from "./lease-writes";
import {
  buildToolModelMessage,
  serializeToolOutputForStorage,
  toPersistedModelMessage,
} from "./model-messages";
import { RunAbortError, RunLeaseLostError, withRunControlChecks } from "./run-control";
import { resolveSandboxToolPath, runSandboxTool, type SandboxHandle } from "./sandbox";
import type { ToolStartCoordinator } from "./tool-start-coordinator";
import { recordToolUsage } from "./usage-recorder";

const HOSTED_TOOL_CALL_LIMITS_PER_MESSAGE: Partial<Record<RuntimeToolName, number>> = {
  exa_search: 8,
  exa_contents: 8,
  exa_answer: 4,
  web_fetch: 12,
};

type ToolObservabilityContext = {
  workspaceId?: string;
  userId?: string;
  agentId?: string;
  modelProvider?: string;
  modelName?: string;
};

type ToolBudget = {
  reserve: (definition: RuntimeToolDefinition) => () => void;
};

type FailedToolOutput = {
  ok: false;
  error: {
    message: string;
    code: string;
    recoverable: true;
  };
};

type DelegateToAgent = (input: {
  agent?: string;
  sessionId?: string;
  prompt: string;
  toolCallId: string;
}) => Promise<unknown>;

class RecoverableToolError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "RecoverableToolError";
    this.code = code;
  }
}

export function createToolSet(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  workspaceId: string;
  agentConfig: AgentConfig;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  repository?: WorkspaceRepository | null | undefined;
  signal: AbortSignal;
  checkAbort: () => Promise<void>;
  toolStartCoordinator: ToolStartCoordinator;
  observabilityContext?: ToolObservabilityContext | undefined;
  toolBudget?: ToolBudget | undefined;
  delegateToAgent?: DelegateToAgent | undefined;
}) {
  const tools: ToolSet = {};

  for (const definition of RUNTIME_TOOL_DEFINITIONS) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters as Parameters<typeof jsonSchema>[0]),
      onInputAvailable: async ({ input: toolInput, toolCallId }) => {
        await input.checkAbort();
        input.toolStartCoordinator.record({
          toolCallId,
          name: definition.name,
          input: toolInput,
        });
      },
      execute: async (toolInput, options) => {
        await input.toolStartCoordinator.waitForStarted(options.toolCallId, input.signal);
        return executeRuntimeTool({
          sessionId: input.sessionId,
          assistantMessageId: input.assistantMessageId,
          runLeaseId: input.runLeaseId,
          runLeaseOwner: input.runLeaseOwner,
          ...(input.internalMessages ? { internalMessages: true } : {}),
          workspaceId: input.workspaceId,
          agentConfig: input.agentConfig,
          toolCallId: options.toolCallId,
          definition,
          args: toolInput,
          getSandbox: input.getSandbox,
          workdir: input.workdir,
          env: input.env,
          enabledTools: input.enabledTools,
          repository: input.repository,
          signal: input.signal,
          checkAbort: input.checkAbort,
          observabilityContext: input.observabilityContext,
          toolBudget: input.toolBudget,
          delegateToAgent: input.delegateToAgent,
        });
      },
    }) as ToolSet[string];
  }

  return tools;
}

export function pickRuntimeTools(tools: ToolSet, names: string[]) {
  const picked: ToolSet = {};
  for (const name of names) {
    if (tools[name]) picked[name] = tools[name];
  }
  return picked;
}

export function createHostedToolBudget(): ToolBudget {
  const callsByTool = new Map<RuntimeToolName, number>();

  return {
    reserve(definition) {
      if (definition.kind !== "hosted") return () => {};

      const limit = HOSTED_TOOL_CALL_LIMITS_PER_MESSAGE[definition.name];
      if (limit === undefined) return () => {};

      const used = callsByTool.get(definition.name) ?? 0;
      if (used >= limit) {
        throw new RecoverableToolError(
          `${formatRuntimeToolName(definition.name)} reached the per-response limit of ${limit} calls. Summarize what you found so far, broaden one follow-up search, or ask the user to continue instead of starting more granular searches.`,
          "tool_call_limit_exceeded",
        );
      }

      callsByTool.set(definition.name, used + 1);
      return () => {};
    },
  };
}

function formatRuntimeToolName(name: RuntimeToolName) {
  return name.replace(/_/g, " ");
}

export async function executeRuntimeTool(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  workspaceId?: string;
  agentConfig?: AgentConfig;
  toolCallId: string;
  definition: RuntimeToolDefinition;
  args: unknown;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  repository?: WorkspaceRepository | null | undefined;
  signal: AbortSignal;
  checkAbort: () => Promise<void>;
  observabilityContext?: ToolObservabilityContext | undefined;
  toolBudget?: ToolBudget | undefined;
  delegateToAgent?: DelegateToAgent | undefined;
}) {
  let output: unknown;
  let failedOutput: FailedToolOutput | null = null;
  let usage: HostedToolUsage | undefined;
  let sandboxIdForCapture: string | undefined;
  let releaseToolBudget: (() => void) | undefined;
  try {
    releaseToolBudget = input.toolBudget?.reserve(input.definition);
    output = await withRunControlChecks(input.checkAbort, async () => {
      throwIfAborted(input.signal);

      if (input.definition.kind === "hosted") {
        const result = await executeHostedTool({
          name: input.definition.name,
          args: input.args,
          env: input.env,
          enabledTools: input.enabledTools,
          signal: input.signal,
        });
        usage = result.usage;
        return result.output;
      }
      if (input.definition.kind === "internal") {
        if (input.definition.name !== "delegate_to_agent") {
          throw new RecoverableToolError("Unknown internal tool.", "unknown_internal_tool");
        }
        const args = readDelegateToAgentArgs(input.args);
        if (!input.delegateToAgent) {
          throw new RecoverableToolError(
            "Agent delegation is not available in this run.",
            "agent_delegation_unavailable",
          );
        }
        return input.delegateToAgent({ ...args, toolCallId: input.toolCallId });
      }

      preflightSandboxToolArgs({
        name: input.definition.name,
        args: input.args,
        workdir: input.workdir,
      });
      const activeSandbox = await input.getSandbox();
      sandboxIdForCapture = activeSandbox.sandboxId;
      if (input.definition.name === "amp_coder") {
        if (!input.workspaceId || !input.agentConfig) {
          throw new Error("AMP requires workspace and agent configuration context.");
        }
        return runAmpCoderTool({
          sandbox: activeSandbox,
          workdir: input.workdir,
          args: input.args,
          sessionId: input.sessionId,
          messageId: input.assistantMessageId,
          workspaceId: input.workspaceId,
          toolCallId: input.toolCallId,
          agentConfig: input.agentConfig,
          env: input.env,
          runLeaseId: input.runLeaseId,
          runLeaseOwner: input.runLeaseOwner,
          onOutput: async (delta) => {
            await input.checkAbort();
            await requireLeaseWrite(
              appendRuntimeEventForLease({
                sessionId: input.sessionId,
                messageId: input.assistantMessageId,
                leaseId: input.runLeaseId,
                leaseOwner: input.runLeaseOwner,
                type: "command.output",
                payload: {
                  command: input.definition.name,
                  toolCallId: input.toolCallId,
                  stream: "stdout",
                  delta,
                },
              }),
            );
          },
        });
      }
      const brainSnapshotBefore =
        input.definition.name === "shell"
          ? await readSandboxBrainSnapshot(activeSandbox, input.workdir)
          : null;
      const shellGitHubAuth =
        input.definition.name === "shell"
          ? await resolveShellGitHubAuth({
              workspaceId: input.workspaceId,
              agentConfig: input.agentConfig,
              toolCallId: input.toolCallId,
            })
          : null;
      const sandboxOutput = await runSandboxTool({
        sandbox: activeSandbox,
        workdir: input.workdir,
        name: input.definition.name,
        args: input.args,
        ...(shellGitHubAuth
          ? { envs: shellGitHubAuth.env, redactOutput: shellGitHubAuth.redact }
          : {}),
        onOutput: async (stream, delta) => {
          await input.checkAbort();
          await requireLeaseWrite(
            appendRuntimeEventForLease({
              sessionId: input.sessionId,
              messageId: input.assistantMessageId,
              leaseId: input.runLeaseId,
              leaseOwner: input.runLeaseOwner,
              type: "command.output",
              payload: {
                command: input.definition.name,
                toolCallId: input.toolCallId,
                stream,
                delta,
              },
            }),
          );
        },
      });
      if (
        input.definition.name === "shell" &&
        brainSnapshotBefore !== null &&
        brainSnapshotBefore !== (await readSandboxBrainSnapshot(activeSandbox, input.workdir))
      ) {
        return { output: sandboxOutput, brainChanged: true };
      }
      return sandboxOutput;
    });
  } catch (error) {
    if (isFatalToolError(error, input.definition.kind, sandboxIdForCapture, input.signal)) {
      throw error;
    }

    captureException(error, {
      event: "opencompany.runner_tool_failed",
      workspace_id: input.observabilityContext?.workspaceId,
      user_id: input.observabilityContext?.userId,
      agent_id: input.observabilityContext?.agentId,
      session_id: input.sessionId,
      message_id: input.assistantMessageId,
      tool_call_id: input.toolCallId,
      tool_name: input.definition.name,
      tool_kind: input.definition.kind,
      sandbox_id: sandboxIdForCapture,
      model_provider: input.observabilityContext?.modelProvider,
      model_name: input.observabilityContext?.modelName,
      ...(input.definition.kind === "hosted"
        ? getHostedToolFailureContext({
            name: input.definition.name,
            args: input.args,
            error,
          })
        : {}),
    });
    failedOutput = buildFailedToolOutput(error);
    output = failedOutput;
  } finally {
    releaseToolBudget?.();
  }

  const changedPath =
    !failedOutput && isRecord(output) && Object.prototype.hasOwnProperty.call(output, "path")
      ? (output as { path: unknown }).path
      : null;
  const fileMutationTool =
    input.definition.name === "write_file" || input.definition.name === "edit_file";
  if (fileMutationTool && typeof changedPath === "string") {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "file.changed",
        payload: { path: changedPath, operation: "write" },
      }),
    );
  }

  const shellOutput = isRecord(output) && "brainChanged" in output ? output.output : output;
  const shellChangedBrain = isRecord(output) && output.brainChanged === true;
  if (isRecord(output) && "brainChanged" in output) {
    output = shellOutput;
  }
  const toolChangedBrain =
    fileMutationTool &&
    typeof changedPath === "string" &&
    changedPath.replace(/^\/+/, "").startsWith("brain/");
  if (
    !failedOutput &&
    input.definition.kind === "sandbox" &&
    (toolChangedBrain || shellChangedBrain)
  ) {
    const activeSandbox = await input.getSandbox();
    await syncBrainFromSandbox({
      sandbox: activeSandbox,
      sessionId: input.sessionId,
      workspaceId: input.observabilityContext?.workspaceId ?? "",
      workdir: input.workdir,
      repository: input.repository,
    });
  }

  if (usage) {
    await recordToolUsage({
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      runLeaseOwner: input.runLeaseOwner,
      toolCallId: input.toolCallId,
      toolName: input.definition.name,
      usage,
    });
  }

  const toolMessageId = newAgentSessionMessageId();
  await requireLeaseWrite(
    insertToolMessageForLease({
      id: toolMessageId,
      sessionId: input.sessionId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      content: serializeToolOutputForStorage(output),
      modelMessage: toPersistedModelMessage(
        buildToolModelMessage({
          toolCallId: input.toolCallId,
          toolName: input.definition.name,
          output,
        }),
      ),
      toolName: input.definition.name,
      toolCallId: input.toolCallId,
      internal: input.internalMessages ?? false,
    }),
  );
  if (failedOutput) {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "tool.failed",
        payload: {
          messageId: input.assistantMessageId,
          toolCallId: input.toolCallId,
          name: input.definition.name,
          error: failedOutput.error,
          output,
        },
      }),
    );
  } else {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "tool.completed",
        payload: {
          messageId: input.assistantMessageId,
          toolCallId: input.toolCallId,
          name: input.definition.name,
          output,
        },
      }),
    );
  }

  return output;
}

async function resolveShellGitHubAuth(input: {
  workspaceId?: string | undefined;
  agentConfig?: AgentConfig | undefined;
  toolCallId: string;
}) {
  if (!input.workspaceId || !input.agentConfig) return null;

  const ampTool = input.agentConfig.tools.find((tool) => tool.id === "amp");
  if (!ampTool || ampTool.id !== "amp" || !ampTool.repository) return null;

  const repository =
    input.agentConfig.integrations.github.repositories.find(
      (candidate) => candidate.id === ampTool.repository,
    ) ?? null;
  if (!repository) {
    throw new Error(`GitHub repository binding ${ampTool.repository} was not found.`);
  }

  const integrationRepository = await loadGitHubWorkRepository(input.workspaceId, repository);
  const githubToken = await getGitHubWorkInstallationToken({
    installationId: integrationRepository.installationId,
    repositoryFullName: repository.fullName,
  });
  if (!githubToken) {
    throw new Error(
      "GitHub App credentials are required to run shell commands in a GitHub work repository.",
    );
  }

  const githubAuthHeader = gitAuthHeader(githubToken);
  return {
    env: buildGitHubCommandEnv({
      githubAuthHeader,
      githubToken,
      toolCallId: input.toolCallId,
    }),
    redact: createKnownSecretRedactor([githubToken, githubAuthHeader]),
  };
}

function gitAuthHeader(token: string) {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  )}`;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run aborted.");
  }
}

function preflightSandboxToolArgs(input: {
  name: RuntimeToolName;
  args: unknown;
  workdir: string;
}) {
  if (
    input.name !== "read_file" &&
    input.name !== "write_file" &&
    input.name !== "edit_file" &&
    input.name !== "list_files"
  ) {
    return;
  }

  const args = isRecord(input.args) ? input.args : {};
  const pathValue = args.path;
  if (input.name !== "list_files" && typeof pathValue !== "string") {
    throw new RecoverableToolError("Tool argument path must be a string.", "invalid_tool_input");
  }
  if (input.name === "list_files" && pathValue !== undefined && typeof pathValue !== "string") {
    throw new RecoverableToolError("Tool argument path must be a string.", "invalid_tool_input");
  }

  try {
    resolveSandboxToolPath(input.workdir, typeof pathValue === "string" ? pathValue : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid sandbox path.";
    throw new RecoverableToolError(
      `${message} Use paths prefixed with work/ for scratch files or brain/ for mounted Brain files.`,
      "invalid_sandbox_path",
    );
  }
}

function isFatalToolError(
  error: unknown,
  toolKind: RuntimeToolDefinition["kind"],
  sandboxIdForCapture: string | undefined,
  signal: AbortSignal,
) {
  if (
    signal.aborted ||
    error instanceof RunAbortError ||
    error instanceof RunLeaseLostError ||
    error instanceof StaleRunLeaseError
  ) {
    return true;
  }

  if (error instanceof MissingEnvError) return true;
  if (error instanceof RecoverableToolError) return false;
  return toolKind === "sandbox" && !sandboxIdForCapture;
}

function buildFailedToolOutput(error: unknown): FailedToolOutput {
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : "Tool failed.",
      code: error instanceof RecoverableToolError ? error.code : "tool_execution_failed",
      recoverable: true,
    },
  };
}

function readDelegateToAgentArgs(args: unknown) {
  const record = isRecord(args) ? args : {};
  const agent = typeof record.agent === "string" ? record.agent.trim() : "";
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";

  if (Boolean(agent) === Boolean(sessionId)) {
    throw new RecoverableToolError(
      "Pass exactly one of agent or sessionId to delegate_to_agent.",
      "invalid_tool_input",
    );
  }
  if (!prompt) {
    throw new RecoverableToolError(
      "Tool argument prompt must be a non-empty string.",
      "invalid_tool_input",
    );
  }

  return {
    ...(agent ? { agent } : {}),
    ...(sessionId ? { sessionId } : {}),
    prompt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
