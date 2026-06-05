import {
  AGENT_SELF_EDIT_SKILL_ID,
  type AgentConfig,
  BUILTIN_USE_TOOL_NAME,
  buildDeniedToolOutput,
  isDeferrableRuntimeTool,
  newAgentSessionMessageId,
  RUNTIME_TOOL_DEFINITION_BY_NAME,
  RUNTIME_TOOL_DEFINITIONS,
  type RuntimeToolDefinition,
  type RuntimeToolName,
} from "@opencompany/agent-runtime";
import type { WorkspaceRepository } from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
import { jsonSchema, type ToolSet, tool } from "ai";
import { applyAgentSelfUpdate } from "./agent-self-edit";
import {
  buildGitHubCommandEnv,
  createKnownSecretRedactor,
  readSandboxBrainSnapshot,
  resolveAttachedRepositoryInstallations,
  runAmpCoderTool,
} from "./amp-tool";
import { syncBrainFromSandbox } from "./brain";
import type { RunnerEnv } from "./env";
import { publishTransientRuntimeEvent } from "./events";
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
import { runOpencodeCoderTool } from "./opencode-tool";
import {
  RunAbortError,
  type RunControlCheck,
  RunLeaseLostError,
  withRunControlChecks,
} from "./run-control";
import { resolveSandboxToolPath, runSandboxTool, type SandboxHandle } from "./sandbox";
import { hasReadSkill, markSkillRead } from "./self-edit-gate";
import type { ToolStartCoordinator, ToolStartVerdict } from "./tool-start-coordinator";
import { recordToolUsage } from "./usage-recorder";

const HOSTED_TOOL_CALL_LIMITS_PER_MESSAGE: Partial<Record<RuntimeToolName, number>> = {
  exa_search: 8,
  exa_contents: 8,
  exa_answer: 4,
  x_search_posts: 4,
  x_get_profile: 8,
  x_get_user_posts: 4,
  x_get_discussion: 3,
  x_get_trends: 4,
  youtube_search: 6,
  youtube_get_video: 8,
  youtube_get_transcript: 6,
  youtube_get_channel: 6,
  youtube_list_channel_videos: 4,
  tiktok_get_profile: 8,
  tiktok_list_profile_posts: 4,
  tiktok_get_video: 8,
  tiktok_get_comments: 4,
  tiktok_search: 4,
  tiktok_get_metadata: 8,
  tiktok_get_transcript: 6,
  instagram_get_profile: 8,
  instagram_list_profile_posts: 4,
  instagram_get_post: 8,
  instagram_get_comments: 4,
  instagram_search_profiles: 4,
  instagram_get_metadata: 8,
  instagram_get_transcript: 6,
  social_get_job: 8,
  web_fetch: 12,
};
const COMMAND_OUTPUT_FLUSH_INTERVAL_MS = 250;
const COMMAND_OUTPUT_FLUSH_CHARS = 1024;

// Returned by a tool's execute() when the run is suspending at an "ask" gate. The stream
// is torn down immediately after, so this value is discarded — it is never persisted as a
// tool-result nor sent to the model. The real body runs in the resume run.
export const SUSPENDED_TOOL_OUTPUT = { ok: false, suspended: true } as const;

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
  checkAbort: RunControlCheck;
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
        const verdict = await input.toolStartCoordinator.waitForStarted(
          options.toolCallId,
          input.signal,
        );
        // The run is unwinding to wait for an approval decision. Return a discarded
        // no-op: the stream is being torn down and this result is never persisted or
        // sent to the model. The body runs later in the resume run.
        if (verdict.decision === "suspend") {
          return SUSPENDED_TOOL_OUTPUT;
        }
        if (verdict.decision === "deny") {
          return persistDeniedToolResult({
            sessionId: input.sessionId,
            assistantMessageId: input.assistantMessageId,
            runLeaseId: input.runLeaseId,
            runLeaseOwner: input.runLeaseOwner,
            internalMessages: input.internalMessages,
            toolCallId: options.toolCallId,
            toolName: definition.name,
            verdict,
          });
        }
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

  // The generic built-in dispatcher. Deferred capability tools are not registered with their own
  // schemas; the model lists them with tool_search and runs one through this single tool. Mirrors
  // the per-server MCP `{server}__use_tool` meta-tool: same approval gate, same persistence tail.
  tools[BUILTIN_USE_TOOL_NAME] = tool({
    description:
      "Run a tool that is not preloaded. Set `tool` to a name returned by tool_search and " +
      "`arguments` to that tool's input. Each underlying tool keeps its own permission, so a write " +
      "or destructive tool may require approval.",
    inputSchema: jsonSchema(BUILTIN_USE_TOOL_INPUT_SCHEMA as never),
    onInputAvailable: async ({ input: toolInput, toolCallId }) => {
      await input.checkAbort();
      input.toolStartCoordinator.record({
        toolCallId,
        name: BUILTIN_USE_TOOL_NAME,
        input: toolInput,
      });
    },
    execute: async (toolInput, options) => {
      const verdict = await input.toolStartCoordinator.waitForStarted(
        options.toolCallId,
        input.signal,
      );
      if (verdict.decision === "suspend") {
        return SUSPENDED_TOOL_OUTPUT;
      }
      if (verdict.decision === "deny") {
        return persistDeniedToolResult({
          sessionId: input.sessionId,
          assistantMessageId: input.assistantMessageId,
          runLeaseId: input.runLeaseId,
          runLeaseOwner: input.runLeaseOwner,
          internalMessages: input.internalMessages,
          toolCallId: options.toolCallId,
          toolName: BUILTIN_USE_TOOL_NAME,
          verdict,
        });
      }
      return dispatchBuiltinUseTool({
        sessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        runLeaseId: input.runLeaseId,
        runLeaseOwner: input.runLeaseOwner,
        ...(input.internalMessages ? { internalMessages: true } : {}),
        workspaceId: input.workspaceId,
        agentConfig: input.agentConfig,
        toolCallId: options.toolCallId,
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

  return tools;
}

const BUILTIN_USE_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: "Exact tool name returned by tool_search.",
    },
    arguments: {
      type: "object",
      description: "Arguments object for the chosen tool, matching its input schema.",
      additionalProperties: true,
    },
  },
  required: ["tool"],
  additionalProperties: false,
} as const;

function parseUseToolInput(args: unknown): { tool: string; arguments: unknown } {
  if (isRecord(args)) {
    const tool = typeof args.tool === "string" ? args.tool.trim() : "";
    return { tool, arguments: args.arguments ?? {} };
  }
  return { tool: "", arguments: {} };
}

// Resolve the named deferred tool and run it through the existing executeRuntimeTool tail, but
// persist the result under `use_tool` so it pairs with the model's dispatcher call. An unknown or
// non-deferred tool name is persisted as a recoverable error pointing back to tool_search.
export async function dispatchBuiltinUseTool(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  workspaceId: string;
  agentConfig: AgentConfig;
  toolCallId: string;
  args: unknown;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  repository?: WorkspaceRepository | null | undefined;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  observabilityContext?: ToolObservabilityContext | undefined;
  toolBudget?: ToolBudget | undefined;
  delegateToAgent?: DelegateToAgent | undefined;
}) {
  const { tool: rawName, arguments: rawArgs } = parseUseToolInput(input.args);
  const definition = rawName
    ? RUNTIME_TOOL_DEFINITION_BY_NAME.get(rawName as RuntimeToolName)
    : undefined;
  if (
    !definition ||
    !isDeferrableRuntimeTool(rawName) ||
    !input.enabledTools.includes(rawName as RuntimeToolName)
  ) {
    return persistBuiltinUseToolError({
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      runLeaseOwner: input.runLeaseOwner,
      ...(input.internalMessages ? { internalMessages: true } : {}),
      toolCallId: input.toolCallId,
      message: rawName
        ? `Unknown or unavailable tool "${rawName}". Call tool_search to list available tools, then pass an exact name as "tool".`
        : 'Missing "tool" argument. Call tool_search to list available tools, then pass one as "tool".',
    });
  }
  return executeRuntimeTool({
    sessionId: input.sessionId,
    assistantMessageId: input.assistantMessageId,
    runLeaseId: input.runLeaseId,
    runLeaseOwner: input.runLeaseOwner,
    ...(input.internalMessages ? { internalMessages: true } : {}),
    workspaceId: input.workspaceId,
    agentConfig: input.agentConfig,
    toolCallId: input.toolCallId,
    definition,
    args: rawArgs,
    persistAsToolName: BUILTIN_USE_TOOL_NAME,
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
}

// Persist a recoverable error tool-result for a `use_tool` call that named no/unknown tool. Mirrors
// the failure tail of executeRuntimeTool so the model recovers turn-by-turn.
async function persistBuiltinUseToolError(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  toolCallId: string;
  message: string;
}) {
  const output: FailedToolOutput = {
    ok: false,
    error: { message: input.message, code: "unknown_runtime_tool", recoverable: true },
  };
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
          toolName: BUILTIN_USE_TOOL_NAME,
          output,
        }),
      ),
      toolName: BUILTIN_USE_TOOL_NAME,
      toolCallId: input.toolCallId,
      internal: input.internalMessages ?? false,
    }),
  );
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
        name: BUILTIN_USE_TOOL_NAME,
        error: output.error,
        outputPreview: formatRuntimePreview(output),
      },
    }),
  );
  return output;
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

// Tool execution is traced by Braintrust's `wrapAISDK` as a tool-call/tool-result pair nested under
// the model's LLM span — no manual span is opened here. Errors are still reported via
// `captureException` for Better Stack.
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
  // When set, the persisted tool-result message and the tool.completed/failed event use this name
  // instead of the runtime tool's own name. Used by the built-in `use_tool` dispatcher so the
  // result pairs with the `use_tool` tool-call the model made (observability still records the real
  // tool via captureException + usage attribution).
  persistAsToolName?: string;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  repository?: WorkspaceRepository | null | undefined;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  observabilityContext?: ToolObservabilityContext | undefined;
  toolBudget?: ToolBudget | undefined;
  delegateToAgent?: DelegateToAgent | undefined;
}) {
  const persistedToolName = input.persistAsToolName ?? input.definition.name;
  let output: unknown;
  let failedOutput: FailedToolOutput | null = null;
  let usage: HostedToolUsage | undefined;
  let sandboxIdForCapture: string | undefined;
  let releaseToolBudget: (() => void) | undefined;
  const commandOutput = createCommandOutputPublisher({
    sessionId: input.sessionId,
    assistantMessageId: input.assistantMessageId,
    toolCallId: input.toolCallId,
    command: input.definition.name,
  });
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
        if (input.definition.name === "update_agent_file") {
          if (!hasReadSkill(input.sessionId, AGENT_SELF_EDIT_SKILL_ID)) {
            return {
              ok: false,
              errors: [
                'Read the agent-self-edit skill first: call read_skill({skillId:"agent-self-edit"}) and follow it, then call update_agent_file again. Nothing was saved.',
              ],
            };
          }
          return applyAgentSelfUpdate({
            sessionId: input.sessionId,
            assistantMessageId: input.assistantMessageId,
            runLeaseId: input.runLeaseId,
            runLeaseOwner: input.runLeaseOwner,
            args: input.args,
          });
        }
        if (input.definition.name === "ask_user_question") {
          // The body only runs when the question could not suspend: a non-suspendable run
          // (delegated child / after-session / background), or malformed questions. The
          // suspend path in model-stream-runner never reaches execute(). Tell the model so it
          // proceeds on its own rather than waiting on input that will never come.
          return {
            status: "unanswered" as const,
            reason:
              "You cannot ask the user a question in this context (no interactive session, or the questions were malformed). Proceed using your best judgment.",
          };
        }
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
        const ampResult = await runAmpCoderTool({
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
            commandOutput.push("stdout", delta);
          },
        });
        if (ampResult.usage) {
          usage = ampResult.usage;
        }
        return ampResult;
      }
      if (input.definition.name === "opencode_coder") {
        if (!input.workspaceId || !input.agentConfig) {
          throw new Error("opencode requires workspace and agent configuration context.");
        }
        const opencodeResult = await runOpencodeCoderTool({
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
            commandOutput.push("stdout", delta);
          },
        });
        if (opencodeResult.usage) {
          usage = opencodeResult.usage;
        }
        return opencodeResult;
      }
      const brainSnapshotBefore =
        input.definition.name === "shell"
          ? await readSandboxBrainSnapshot(activeSandbox, input.workdir)
          : null;
      const shellGitHubAuth =
        input.definition.name === "gh"
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
          commandOutput.push(stream, delta);
        },
      });
      // Reaching here means the read succeeded (read_skill throws on a missing file), so the
      // session can be credited with having read this skill — clearing skill-gated tools.
      if (input.definition.name === "read_skill" && isRecord(input.args)) {
        const skillId = input.args.skillId;
        if (typeof skillId === "string") markSkillRead(input.sessionId, skillId);
      }
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
    commandOutput.flush();
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
          toolName: persistedToolName,
          output,
        }),
      ),
      toolName: persistedToolName,
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
          name: persistedToolName,
          error: failedOutput.error,
          outputPreview: formatRuntimePreview(output),
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
          name: persistedToolName,
          outputPreview: formatRuntimePreview(output),
        },
      }),
    );
  }

  return output;
}

function createCommandOutputPublisher(input: {
  sessionId: string;
  assistantMessageId: string;
  toolCallId: string;
  command: string;
}) {
  let pending = "";
  let pendingStream: "stdout" | "stderr" = "stdout";
  let lastFlushAt = Date.now();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (!pending) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    const delta = pending;
    const stream = pendingStream;
    pending = "";
    lastFlushAt = Date.now();
    publishTransientRuntimeEvent({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      type: "command.output",
      payload: {
        command: input.command,
        toolCallId: input.toolCallId,
        stream,
        delta,
      },
    });
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, COMMAND_OUTPUT_FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  };

  return {
    push(stream: "stdout" | "stderr", delta: string) {
      if (!delta) return;
      if (pending && stream !== pendingStream) flush();
      pendingStream = stream;
      pending += delta;
      if (
        pending.length >= COMMAND_OUTPUT_FLUSH_CHARS ||
        Date.now() - lastFlushAt >= COMMAND_OUTPUT_FLUSH_INTERVAL_MS
      ) {
        flush();
      } else {
        scheduleFlush();
      }
    },
    flush,
  };
}

// Inject repo-scoped git + gh credentials into the explicit gh tool whenever the
// agent has at least one attached GitHub repository. A broken integration
// (e.g. needs-reauth) propagates and surfaces as a recoverable tool error. A single
// installation token cannot span installations, so we scope the token to the repos
// of the first attached repository's installation; cross-installation sessions get
// auth for one installation at a time.
async function resolveShellGitHubAuth(input: {
  workspaceId?: string | undefined;
  agentConfig?: AgentConfig | undefined;
  toolCallId: string;
}) {
  if (!input.workspaceId || !input.agentConfig) return null;

  const repositories = input.agentConfig.integrations.github.repositories;
  if (repositories.length === 0) return null;

  const resolved = await resolveAttachedRepositoryInstallations(input.workspaceId, repositories);
  if (resolved.length === 0) return null;

  const installationId = resolved[0]!.installationId;
  const repositoryFullNames = resolved
    .filter((repository) => repository.installationId === installationId)
    .map((repository) => repository.fullName);

  const githubToken = await getGitHubWorkInstallationToken({
    installationId,
    repositoryFullNames,
  });
  if (!githubToken) return null;

  const githubAuthHeader = gitAuthHeader(githubToken);
  return {
    env: buildGitHubCommandEnv({
      githubAuthHeader,
      githubToken,
      toolCallId: input.toolCallId,
      ...(resolved.length === 1 ? { repositoryFullName: resolved[0]!.fullName } : {}),
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
      `${message} Use paths prefixed with work/ for scratch files, brain/ for mounted Brain files, or agent/ for your private agent folder.`,
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

// A denied tool call still needs a persisted tool result (the model requires one
// result per tool call) and a tool.failed event for the UI, but it never runs the
// real tool body. This mirrors the persistence tail of executeRuntimeTool.
export async function persistDeniedToolResult(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean | undefined;
  toolCallId: string;
  toolName: string;
  verdict: ToolStartVerdict;
}) {
  const output = buildDeniedToolOutput({
    toolName: input.toolName,
    providerKey: input.verdict.providerKey,
    group: input.verdict.group,
    source: input.verdict.source,
  });

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
          toolName: input.toolName,
          output,
        }),
      ),
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      internal: input.internalMessages ?? false,
    }),
  );
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
        name: input.toolName,
        error: output.error,
        outputPreview: formatRuntimePreview(output),
      },
    }),
  );

  return output;
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

export function formatRuntimePreview(value: unknown) {
  let text: string;
  if (value === undefined || value === null) {
    text = "";
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }

  const trimmed = text.trim();
  const maxLength = 900;
  const preview = trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}...`;
  return redactPreviewSecrets(preview);
}

/**
 * Redacts secret-like patterns from a tool output/input preview string before it is
 * persisted to `agent_session_events.payload.outputPreview` (or `inputPreview`).
 *
 * This is a best-effort, defence-in-depth layer — it catches patterns that the
 * known-secret redactor (used for sandbox/shell tools) does not cover, such as raw
 * API keys returned inside MCP tool responses (e.g. PostHog `phc_…` project API keys).
 *
 * Patterns covered:
 *  - HTTP Authorization header values  (Bearer / Basic tokens)
 *  - Generic key=value credential pairs (api_key, token, secret, password, access_key)
 *  - OpenAI-style secret keys          (sk-… ≥12 chars)
 *  - PostHog personal/project API keys (phc_… ≥12 chars)
 *  - GitHub personal access tokens     (ghp_ / ghs_ / github_pat_ prefixes)
 */
export function redactPreviewSecrets(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?key|secret[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted]")
    .replace(/\b(phc_[A-Za-z0-9_-]{12,})\b/g, "[redacted]")
    .replace(/\b(ghp_[A-Za-z0-9]{36,})\b/g, "[redacted]")
    .replace(/\b(ghs_[A-Za-z0-9]{36,})\b/g, "[redacted]")
    .replace(/\b(github_pat_[A-Za-z0-9_]{36,})\b/g, "[redacted]");
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
