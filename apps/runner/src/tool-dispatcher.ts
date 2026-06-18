import {
  AGENT_SELF_EDIT_SKILL_ID,
  type AgentBrainReference,
  type AgentConfig,
  agentHasGitHubAccess,
  BUILTIN_USE_TOOL_NAME,
  buildDeniedToolOutput,
  formatBrainReferenceDisplay,
  getRuntimeToolDefinition,
  getRuntimeToolDefinitions,
  isBrainListingAllowed,
  isBrainPathAllowed,
  isDeferrableRuntimeTool,
  newAgentSessionMessageId,
  parseGitHubCliArgs,
  type RuntimeToolDefinition,
  type RuntimeToolName,
  type ToolArgResolution,
  type ToolCallTimings,
} from "@opencompany/agent-runtime";
import type { WorkspaceRepository } from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
import {
  type BraintrustSpan,
  logBraintrustSpan,
  traceBraintrustStep,
} from "@opencompany/observability/braintrust";
import { jsonSchema, type ToolSet, tool } from "ai";
import { applyAgentSelfUpdate } from "./agent-self-edit";
import {
  buildGitHubCommandEnv,
  createKnownSecretRedactor,
  loadConnectedGitHubInstallation,
  loadGitHubWorkRepositoryByFullName,
  readSandboxBrainSnapshot,
  resolveAttachedRepositoryInstallations,
  runAmpCoderTool,
} from "./amp-tool";
import { syncBrainFromSandbox } from "./brain";
import type { RunnerEnv } from "./env";
import { publishTransientRuntimeEvent } from "./events";
import { runFetchTranscriptTool } from "./fetch-transcript-tool";
import { getGitHubWorkInstallationToken } from "./github";
import {
  executeHostedTool,
  getHostedToolFailureContext,
  type HostedToolUsage,
  MissingEnvError,
} from "./hosted-tools";
import { runInboxTool } from "./inbox-tool";
import {
  appendRuntimeEventForLease,
  insertToolMessageForLease,
  requireLeaseWrite,
  StaleRunLeaseError,
} from "./lease-writes";
import { runCreateLinearIssueTool } from "./linear-issue-tool";
import { runMemoryTool } from "./memory-tool";
import {
  buildToolModelMessage,
  serializeToolOutputForStorage,
  toPersistedModelMessage,
} from "./model-messages";
import { runOpencodeCoderTool } from "./opencode-tool";
import { runRecallTool } from "./recall-tool";
import { runRestoreBrainTool } from "./restore-brain-tool";
import {
  RunAbortError,
  type RunControlCheck,
  RunLeaseLostError,
  withRunControlChecks,
} from "./run-control";
import {
  resolveSandboxBrainRelativePath,
  resolveSandboxToolPath,
  runSandboxTool,
  type SandboxHandle,
} from "./sandbox";
import { hasReadSkill, markSkillRead } from "./self-edit-gate";
import { prepareToolArgs } from "./tool-arg-repair";
import type { ToolTimingRecord } from "./tool-latency";
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

type RunSubagent = (input: {
  description: string;
  prompt: string;
  tools?: string[] | undefined;
  model?: string | undefined;
  max_steps?: number | undefined;
  toolCallId: string;
}) => Promise<unknown>;

// Wall-clock anchors for one tool call's phase breakdown (ToolCallTimings). Created at execute()
// entry in createToolSet so the gate wait (waitForStarted: stream-loop scheduling + policy +
// the blocking tool.started write) is included; executeRuntimeTool fills in the later phases.
type ToolCallPhaseTimer = {
  executeStartedAt: number;
  gateWaitMs: number;
};

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
  // True for the user's personal/default agent — selects the memory/ + personal-brain/ + work/
  // sandbox layout and matching path whitelist for the file/memory tools.
  personalAgent?: boolean;
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
  runSubagent?: RunSubagent | undefined;
  // Receives each call's ToolCallTimings once measured (per-turn rollup + slow-call analytics).
  onToolTimings?: ((record: ToolTimingRecord) => void) | undefined;
}) {
  const tools: ToolSet = {};

  for (const definition of getRuntimeToolDefinitions({
    personalAgent: input.personalAgent ?? false,
  })) {
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
        const executeStartedAt = performance.now();
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
          phaseTimer: {
            executeStartedAt,
            gateWaitMs: performance.now() - executeStartedAt,
          },
          onToolTimings: input.onToolTimings,
          sessionId: input.sessionId,
          assistantMessageId: input.assistantMessageId,
          runLeaseId: input.runLeaseId,
          runLeaseOwner: input.runLeaseOwner,
          ...(input.internalMessages ? { internalMessages: true } : {}),
          workspaceId: input.workspaceId,
          agentConfig: input.agentConfig,
          personalAgent: input.personalAgent ?? false,
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
          runSubagent: input.runSubagent,
        });
      },
    }) as ToolSet[string];
  }

  // The generic built-in dispatcher. Deferred capability tools are not registered with their own
  // schemas; the model lists them with find_tools and runs one through this single tool. Mirrors
  // the per-server MCP `{server}__use_tool` meta-tool: same approval gate, same persistence tail.
  tools[BUILTIN_USE_TOOL_NAME] = tool({
    description:
      "Run a tool that is not preloaded. Set `tool` to a name returned by find_tools and " +
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
      const executeStartedAt = performance.now();
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
        phaseTimer: {
          executeStartedAt,
          gateWaitMs: performance.now() - executeStartedAt,
        },
        onToolTimings: input.onToolTimings,
        sessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        runLeaseId: input.runLeaseId,
        runLeaseOwner: input.runLeaseOwner,
        ...(input.internalMessages ? { internalMessages: true } : {}),
        workspaceId: input.workspaceId,
        agentConfig: input.agentConfig,
        personalAgent: input.personalAgent ?? false,
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
        runSubagent: input.runSubagent,
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
      description: "Exact tool name returned by find_tools.",
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
// non-deferred tool name is persisted as a recoverable error pointing back to find_tools.
export async function dispatchBuiltinUseTool(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  workspaceId: string;
  agentConfig: AgentConfig;
  personalAgent?: boolean;
  toolCallId: string;
  args: unknown;
  phaseTimer?: ToolCallPhaseTimer | undefined;
  onToolTimings?: ((record: ToolTimingRecord) => void) | undefined;
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
  runSubagent?: RunSubagent | undefined;
}) {
  const { tool: rawName, arguments: rawArgs } = parseUseToolInput(input.args);
  const definition = rawName
    ? getRuntimeToolDefinition(rawName as RuntimeToolName, {
        personalAgent: input.personalAgent ?? false,
      })
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
        ? `Unknown or unavailable tool "${rawName}". Call find_tools to list available tools, then pass an exact name as "tool".`
        : 'Missing "tool" argument. Call find_tools to list available tools, then pass one as "tool".',
    });
  }
  // Layers 1–3 (validate → coerce → repair). The repair fallback is gated on the gateway key +
  // kill switch; when off (e.g. unit tests with an empty env) only the deterministic layers run.
  const prepared = await prepareToolArgs({
    surface: "builtin",
    toolName: rawName,
    schema: definition.parameters,
    rawArgs,
    repair: {
      apiKey: input.env.vercelAiGatewayApiKey,
      enabled: input.env.toolArgRepairEnabled,
    },
    signal: input.signal,
    observability: {
      sessionId: input.sessionId,
      ...(input.observabilityContext?.workspaceId
        ? { workspaceId: input.observabilityContext.workspaceId }
        : {}),
      ...(input.observabilityContext?.agentId
        ? { agentId: input.observabilityContext.agentId }
        : {}),
      ...(input.observabilityContext?.modelName
        ? { modelName: input.observabilityContext.modelName }
        : {}),
    },
  });
  if (!prepared.ok) {
    return persistBuiltinUseToolError({
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      runLeaseOwner: input.runLeaseOwner,
      ...(input.internalMessages ? { internalMessages: true } : {}),
      toolCallId: input.toolCallId,
      message: `Invalid arguments for "${rawName}": ${prepared.errors
        .map((error) => error.message)
        .join(
          "; ",
        )}. Call tool_help({ tool: "${rawName}" }) for its schema, then retry use_tool with arguments that match it.`,
      code: "invalid_tool_input",
      argResolution: prepared.resolution,
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
    personalAgent: input.personalAgent ?? false,
    toolCallId: input.toolCallId,
    definition,
    args: prepared.args,
    persistAsToolName: BUILTIN_USE_TOOL_NAME,
    argResolution: prepared.resolution,
    phaseTimer: input.phaseTimer,
    onToolTimings: input.onToolTimings,
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
    runSubagent: input.runSubagent,
  });
}

// Persist a recoverable error tool-result for a `use_tool` call that named no/unknown tool or passed
// arguments that fail its schema. Mirrors the failure tail of executeRuntimeTool so the model
// recovers turn-by-turn. `code` defaults to the unknown-tool case; arg-validation failures pass
// "invalid_tool_input" to match the rest of the runtime's recoverable input errors.
async function persistBuiltinUseToolError(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  toolCallId: string;
  message: string;
  code?: string;
  argResolution?: ToolArgResolution | undefined;
}) {
  const output: FailedToolOutput = {
    ok: false,
    error: {
      message: input.message,
      code: input.code ?? "unknown_runtime_tool",
      recoverable: true,
    },
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
        ...(input.argResolution ? { argResolution: input.argResolution } : {}),
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

type ExecuteRuntimeToolInput = {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  workspaceId?: string;
  agentConfig?: AgentConfig;
  personalAgent?: boolean;
  toolCallId: string;
  definition: RuntimeToolDefinition;
  args: unknown;
  // When set, the persisted tool-result message and the tool.completed/failed event use this name
  // instead of the runtime tool's own name. Used by the built-in `use_tool` dispatcher so the
  // result pairs with the `use_tool` tool-call the model made (observability still records the real
  // tool via captureException + usage attribution).
  persistAsToolName?: string;
  // How the deferred-tool arguments were resolved (valid/coerced/repaired) before this ran. Carried
  // onto the tool.completed/failed event for telemetry. Only set on the use_tool dispatch path.
  argResolution?: ToolArgResolution | undefined;
  // Wall-clock anchors from the execute() entry point so the timing breakdown can include the
  // gate wait. Absent on the resume path (agent-loop) where there is no gate.
  phaseTimer?: ToolCallPhaseTimer | undefined;
  // Receives this call's ToolCallTimings once measured (per-turn rollup + slow-call analytics).
  onToolTimings?: ((record: ToolTimingRecord) => void) | undefined;
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
  runSubagent?: RunSubagent | undefined;
};

// Braintrust's `wrapAISDK` already traces tool execution as a tool-call/tool-result pair nested
// under the model's LLM span, but that span is a single opaque duration and is unreachable from
// inside execute() (wrapAISDK starts the body before entering the span context). This explicit
// span carries the per-phase latency breakdown (gate wait / sandbox wait / body / persistence
// tail) as metrics — the same numbers persisted on the tool.completed/failed event as `timings` —
// so slow tool calls can be attributed post-hoc. Errors are still reported via `captureException`
// for Better Stack.
export async function executeRuntimeTool(input: ExecuteRuntimeToolInput) {
  return traceBraintrustStep(
    `tool:${input.definition.name}`,
    (span) => executeRuntimeToolInner(input, span),
    {
      tool_name: input.definition.name,
      tool_kind: input.definition.kind,
      tool_call_id: input.toolCallId,
      session_id: input.sessionId,
      ...(input.persistAsToolName ? { persisted_tool_name: input.persistAsToolName } : {}),
    },
    { type: "tool" },
  );
}

async function executeRuntimeToolInner(
  input: ExecuteRuntimeToolInput,
  span: BraintrustSpan | undefined,
) {
  const bodyStartedAt = performance.now();
  let bodyEndedAt = bodyStartedAt;
  let sandboxWaitMs = 0;
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
          personalAgent: input.personalAgent ?? false,
          hasAttachedRepository:
            Boolean(input.repository) ||
            (input.agentConfig ? agentHasGitHubAccess(input.agentConfig) : false),
          googleContext: input.workspaceId
            ? {
                workspaceId: input.workspaceId,
                encryptionKey: input.env.integrationCredentialEncryptionKey,
                clientId: input.env.googleOAuthClientId,
                clientSecret: input.env.googleOAuthClientSecret,
              }
            : undefined,
          neonContext: input.workspaceId
            ? {
                workspaceId: input.workspaceId,
                encryptionKey: input.env.integrationCredentialEncryptionKey,
              }
            : undefined,
        });
        usage = result.usage;
        return result.output;
      }
      if (input.definition.kind === "internal") {
        if (input.definition.name === "recall") {
          // Runner-side, no sandbox, no Gateway key: queries Postgres directly, scoped to this
          // agent + user via the current session row, excluding the live session.
          return runRecallTool({ sessionId: input.sessionId, args: input.args });
        }
        if (
          input.definition.name === "inbox_list" ||
          input.definition.name === "inbox_add" ||
          input.definition.name === "inbox_update"
        ) {
          // Runner-side write to the user's personal inbox, scoped to this session's
          // (workspace, user). Hard-gated to the personal agent at config resolution.
          return runInboxTool({
            name: input.definition.name,
            sessionId: input.sessionId,
            args: input.args,
          });
        }
        if (input.definition.name === "fetch_transcript") {
          // Runner-side, no sandbox: reads the full transcript of a session the caller is allowed
          // to see (its own past sessions, or the parent it was spawned to review).
          return runFetchTranscriptTool({ callerSessionId: input.sessionId, args: input.args });
        }
        if (input.definition.name === "create_linear_issue") {
          // Runner-side: creates an issue in the workspace's OWN connected Linear by driving its
          // MCP connection (same decrypted creds as the agent's linear tools). Needs a workspace.
          if (!input.workspaceId) {
            throw new RecoverableToolError(
              "Creating a Linear issue requires a workspace context.",
              "missing_workspace",
            );
          }
          return runCreateLinearIssueTool({
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            args: input.args,
            integrationCredentialEncryptionKey: input.env.integrationCredentialEncryptionKey,
            blobReadWriteToken: input.env.blobReadWriteToken,
            signal: input.signal,
          });
        }
        if (input.definition.name === "restore_brain_file") {
          // Runner-side: restores a brain knowledge file to a saved version (PRO-244). Company scope
          // touches brain_files; personal scope touches this agent's agent_files. Needs a workspace;
          // the personal path additionally needs the owning agentId (the tool returns a recoverable
          // error when it is missing).
          if (!input.workspaceId) {
            throw new RecoverableToolError(
              "Restoring a brain file requires a workspace context.",
              "missing_workspace",
            );
          }
          return runRestoreBrainTool({
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            agentId: input.observabilityContext?.agentId,
            personalAgent: input.personalAgent ?? false,
            args: input.args,
          });
        }
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
        if (input.definition.name === "run_subagent") {
          const args = readRunSubagentArgs(input.args);
          if (!input.runSubagent) {
            throw new RecoverableToolError(
              "Subagents are not available in this run.",
              "subagent_unavailable",
            );
          }
          return input.runSubagent({ ...args, toolCallId: input.toolCallId });
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
        brainReferences: input.agentConfig?.brain ?? [],
        personal: input.personalAgent ?? false,
      });
      // The first sandbox tool of a turn pays the whole hydration here (connect/resume +
      // prepare + materialize); later calls resolve the memoized handle instantly. Timed
      // separately so a slow "read_file" is attributable to hydration vs the read itself.
      const sandboxWaitStartedAt = performance.now();
      const activeSandbox = await input.getSandbox();
      sandboxWaitMs += performance.now() - sandboxWaitStartedAt;
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
      if (input.definition.name === "memory") {
        const memoryResult = await runMemoryTool({
          sandbox: activeSandbox,
          workdir: input.workdir,
          args: input.args,
          env: input.env,
          personal: input.personalAgent ?? false,
          onOutput: async (stream, delta) => {
            await input.checkAbort();
            commandOutput.push(stream, delta);
          },
        });
        if (memoryResult.usage) {
          usage = memoryResult.usage;
        }
        return memoryResult.output;
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
              args: input.args,
              toolCallId: input.toolCallId,
            })
          : null;
      const sandboxOutput = await runSandboxTool({
        sandbox: activeSandbox,
        workdir: input.workdir,
        name: input.definition.name,
        args: input.args,
        personal: input.personalAgent ?? false,
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
    bodyEndedAt = performance.now();
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

  let persistedOutput = output;
  let persistedFailedOutput = failedOutput;
  try {
    await persistToolResultMessage({
      sessionId: input.sessionId,
      runLeaseId: input.runLeaseId,
      runLeaseOwner: input.runLeaseOwner,
      toolCallId: input.toolCallId,
      toolName: persistedToolName,
      internal: input.internalMessages ?? false,
      output: persistedOutput,
    });
  } catch (error) {
    if (isFatalToolResultPersistenceError(error)) {
      throw error;
    }

    const sanitizedError = new Error("Tool result persistence failed.");
    sanitizedError.name = "ToolResultPersistenceError";
    captureException(sanitizedError, {
      event: "opencompany.runner_tool_result_persist_failed",
      workspace_id: input.observabilityContext?.workspaceId,
      user_id: input.observabilityContext?.userId,
      agent_id: input.observabilityContext?.agentId,
      session_id: input.sessionId,
      message_id: input.assistantMessageId,
      tool_call_id: input.toolCallId,
      tool_name: input.definition.name,
      persisted_tool_name: persistedToolName,
      tool_kind: input.definition.kind,
      model_provider: input.observabilityContext?.modelProvider,
      model_name: input.observabilityContext?.modelName,
      original_error_name: error instanceof Error ? error.name : typeof error,
    });

    persistedFailedOutput = buildToolResultPersistenceFailedOutput(error);
    persistedOutput = persistedFailedOutput;
    await persistToolResultMessage({
      sessionId: input.sessionId,
      runLeaseId: input.runLeaseId,
      runLeaseOwner: input.runLeaseOwner,
      toolCallId: input.toolCallId,
      toolName: persistedToolName,
      internal: input.internalMessages ?? false,
      output: persistedOutput,
    });
  }

  // Phase breakdown for this call: persisted on the completed/failed event (post-hoc DB
  // queries, stream consumers) and mirrored as metrics on the Braintrust tool span.
  const persistEndedAt = performance.now();
  const timings = buildToolCallTimings({
    phaseTimer: input.phaseTimer,
    bodyStartedAt,
    bodyEndedAt,
    persistEndedAt,
    sandboxWaitMs,
  });
  logBraintrustSpan(span, {
    metrics: {
      ...(timings.gateWaitMs !== undefined ? { gate_wait_ms: timings.gateWaitMs } : {}),
      ...(timings.sandboxWaitMs !== undefined ? { sandbox_wait_ms: timings.sandboxWaitMs } : {}),
      exec_ms: timings.execMs ?? 0,
      persist_ms: timings.persistMs ?? 0,
      total_ms: timings.totalMs ?? 0,
    },
    metadata: {
      ...(sandboxIdForCapture ? { sandbox_id: sandboxIdForCapture } : {}),
      failed: Boolean(persistedFailedOutput),
    },
  });
  try {
    input.onToolTimings?.({
      toolName: input.definition.name,
      toolKind: input.definition.kind,
      toolCallId: input.toolCallId,
      failed: Boolean(persistedFailedOutput),
      timings,
      ...(sandboxIdForCapture ? { sandboxId: sandboxIdForCapture } : {}),
    });
  } catch {
    // Analytics must not affect the tool result.
  }

  if (persistedFailedOutput) {
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
          error: persistedFailedOutput.error,
          outputPreview: formatRuntimePreview(persistedOutput),
          ...(input.argResolution ? { argResolution: input.argResolution } : {}),
          timings,
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
          outputPreview: formatRuntimePreview(persistedOutput),
          ...(input.argResolution ? { argResolution: input.argResolution } : {}),
          timings,
        },
      }),
    );
  }

  return persistedOutput;
}

function buildToolCallTimings(input: {
  phaseTimer: ToolCallPhaseTimer | undefined;
  bodyStartedAt: number;
  bodyEndedAt: number;
  persistEndedAt: number;
  sandboxWaitMs: number;
}): ToolCallTimings {
  const startedAt = input.phaseTimer?.executeStartedAt ?? input.bodyStartedAt;
  return {
    ...(input.phaseTimer ? { gateWaitMs: Math.round(input.phaseTimer.gateWaitMs) } : {}),
    ...(input.sandboxWaitMs > 0 ? { sandboxWaitMs: Math.round(input.sandboxWaitMs) } : {}),
    execMs: Math.round(Math.max(0, input.bodyEndedAt - input.bodyStartedAt - input.sandboxWaitMs)),
    persistMs: Math.round(Math.max(0, input.persistEndedAt - input.bodyEndedAt)),
    totalMs: Math.round(Math.max(0, input.persistEndedAt - startedAt)),
  };
}

async function persistToolResultMessage(input: {
  sessionId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  toolCallId: string;
  toolName: string;
  internal: boolean;
  output: unknown;
}) {
  const toolMessageId = newAgentSessionMessageId();
  await requireLeaseWrite(
    insertToolMessageForLease({
      id: toolMessageId,
      sessionId: input.sessionId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      content: serializeToolOutputForStorage(input.output),
      modelMessage: toPersistedModelMessage(
        buildToolModelMessage({
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          output: input.output,
        }),
      ),
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      internal: input.internal,
    }),
  );
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
// agent has attached GitHub access. A broken integration (e.g. needs-reauth)
// propagates and surfaces as a recoverable tool error. A single installation token
// cannot span installations, so explicit repositories are scoped to one installation.
// With the live `@github` all-repositories scope, `gh --repo owner/repo ...` resolves
// that repository's installation at call time so multi-installation workspaces use
// the token for the requested repo instead of whichever connection was created first.
async function resolveShellGitHubAuth(input: {
  workspaceId?: string | undefined;
  agentConfig?: AgentConfig | undefined;
  args?: unknown;
  toolCallId: string;
}) {
  if (!input.workspaceId || !input.agentConfig) return null;

  const github = input.agentConfig.integrations.github;
  if (github.allRepositories === true) {
    const requestedRepository = readGhRepoArgument(input.args);
    if (requestedRepository) {
      const attachedRepository = github.repositories.find(
        (repository) => repository.fullName.toLowerCase() === requestedRepository.toLowerCase(),
      );
      if (attachedRepository) {
        return resolveAttachedGitHubCommandAuth({
          workspaceId: input.workspaceId,
          repositories: [attachedRepository],
          toolCallId: input.toolCallId,
        });
      }

      const resolved = await loadGitHubWorkRepositoryByFullName(
        input.workspaceId,
        requestedRepository,
      );
      if (!resolved) {
        throw new Error(
          `GitHub work repository ${requestedRepository} is not available to this workspace. Reconnect GitHub or grant the installation access to it.`,
        );
      }

      const githubToken = await getGitHubWorkInstallationToken({
        installationId: resolved.installationId,
        repositoryFullName: resolved.repository.fullName,
      });
      if (!githubToken) return null;

      const githubAuthHeader = gitAuthHeader(githubToken);
      return {
        env: buildGitHubCommandEnv({
          githubAuthHeader,
          githubToken,
          toolCallId: input.toolCallId,
          repositoryFullName: resolved.repository.fullName,
        }),
        redact: createKnownSecretRedactor([githubToken, githubAuthHeader]),
      };
    }

    if (github.repositories.length === 1) {
      return resolveAttachedGitHubCommandAuth({
        workspaceId: input.workspaceId,
        repositories: github.repositories,
        toolCallId: input.toolCallId,
      });
    }

    const installation = await loadConnectedGitHubInstallation(input.workspaceId);
    // GitHub not connected: same graceful no-auth behavior as an agent without repositories.
    if (!installation) return null;

    const githubToken = await getGitHubWorkInstallationToken({
      installationId: installation.installationId,
    });
    if (!githubToken) return null;

    const githubAuthHeader = gitAuthHeader(githubToken);
    return {
      env: buildGitHubCommandEnv({
        githubAuthHeader,
        githubToken,
        toolCallId: input.toolCallId,
        // No GH_REPO default: with installation-wide access the agent must pass --repo.
        ...(github.repositories.length === 1
          ? { repositoryFullName: github.repositories[0]!.fullName }
          : {}),
      }),
      redact: createKnownSecretRedactor([githubToken, githubAuthHeader]),
    };
  }

  const repositories = github.repositories;
  if (repositories.length === 0) return null;

  return resolveAttachedGitHubCommandAuth({
    workspaceId: input.workspaceId,
    repositories,
    toolCallId: input.toolCallId,
  });
}

async function resolveAttachedGitHubCommandAuth(input: {
  workspaceId: string;
  repositories: AgentConfig["integrations"]["github"]["repositories"];
  toolCallId: string;
}) {
  const resolved = await resolveAttachedRepositoryInstallations(
    input.workspaceId,
    input.repositories,
  );
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

function readGhRepoArgument(args: unknown) {
  const argv = isRecord(args) ? parseGitHubCliArgs(args.args) : null;
  if (!argv) return null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") return null;
    if (arg === "--repo" || arg === "-R") {
      const value = argv[index + 1]?.trim();
      return value && isGitHubRepositoryFullName(value) ? value : null;
    }
    if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length).trim();
      return value && isGitHubRepositoryFullName(value) ? value : null;
    }
    if (arg.startsWith("-R") && arg.length > 2) {
      const value = arg.slice(2).trim();
      return value && isGitHubRepositoryFullName(value) ? value : null;
    }
  }
  return null;
}

function isGitHubRepositoryFullName(value: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
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

export function preflightSandboxToolArgs(input: {
  name: RuntimeToolName;
  args: unknown;
  workdir: string;
  brainReferences: AgentBrainReference[];
  personal?: boolean;
}) {
  const personal = input.personal ?? false;
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

  const requestedPath = typeof pathValue === "string" ? pathValue : undefined;
  const requestedRoot = requestedPath
    ?.trim()
    .replace(/^\.?\//, "")
    .split("/")[0];
  if (personal && requestedRoot === "memory") {
    throw new RecoverableToolError(
      "Generic file tools cannot access memory/. Use the memory tool to read or write structured memory.",
      "invalid_sandbox_path",
    );
  }
  // Personal sessions have no company brain/ mount; a write there resolves to no real root and
  // would be silently lost (the PRO-244 "wrong folder" bug). Route the model to personal-brain/
  // explicitly instead of the bare allowed-roots error.
  if (personal && requestedRoot === "brain") {
    const suggested =
      requestedPath
        ?.trim()
        .replace(/^\.?\//, "")
        .replace(/^brain\//, "") || "notes.md";
    throw new RecoverableToolError(
      `brain/ is a company-session root and is not mounted in this personal session — writing here would be lost. Save persistent user content under personal-brain/ instead (e.g. personal-brain/${suggested}), use work/ for private scratch, or agent/ for your private agent folder.`,
      "invalid_sandbox_path",
    );
  }

  let brainRelativePath: string | null;
  try {
    brainRelativePath = resolveSandboxBrainRelativePath(input.workdir, requestedPath, personal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid sandbox path.";
    const hint = personal
      ? "Use paths prefixed with work/ for scratch files, personal-brain/ for the user's private knowledge, or agent/ for your private agent folder. Use the memory tool for structured memory."
      : "Use paths prefixed with work/ for scratch files, brain/ for mounted Brain files, or agent/ for your private agent folder.";
    throw new RecoverableToolError(`${message} ${hint}`, "invalid_sandbox_path");
  }

  // Enforce the agent's true Brain access scope. The root check above only
  // verifies the path is under brain/; here we reject Brain paths the agent's
  // @brain/... references do not mount, so out-of-scope writes fail loudly
  // instead of succeeding in the sandbox and being silently dropped at sync.
  if (brainRelativePath === null) return;

  const allowed =
    input.name === "list_files"
      ? isBrainListingAllowed(brainRelativePath, input.brainReferences)
      : isBrainPathAllowed(brainRelativePath, input.brainReferences);
  if (allowed) return;

  throw new RecoverableToolError(
    brainAccessDeniedMessage(brainRelativePath, input.brainReferences),
    "brain_path_not_mounted",
  );
}

function brainAccessDeniedMessage(
  brainRelativePath: string,
  references: AgentBrainReference[],
): string {
  const target = `brain/${brainRelativePath}`;
  if (references.length === 0) {
    return `${target} is outside this agent's Brain access — this agent has no mounted Brain paths. Add @brain/... references to the agent definition (via self-edit) before reading or writing Brain files, or ask the user to grant access.`;
  }
  const allowed = references
    .map((reference) => formatBrainReferenceDisplay(reference.path))
    .join(", ");
  return `${target} is outside this agent's mounted Brain access. This agent can only read or write Brain files under: ${allowed}. To work elsewhere in the Brain, add the path to this agent's brain refs (e.g. @brain/${brainRelativePath}) via self-edit, or ask the user to grant access.`;
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

function buildToolResultPersistenceFailedOutput(_error: unknown): FailedToolOutput {
  return {
    ok: false,
    error: {
      message:
        "The tool ran, but its output could not be stored safely. Retry with a narrower request or use a different approach.",
      code: "tool_result_persistence_failed",
      recoverable: true,
    },
  };
}

function isFatalToolResultPersistenceError(error: unknown) {
  return (
    error instanceof RunAbortError ||
    error instanceof RunLeaseLostError ||
    error instanceof StaleRunLeaseError
  );
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

function readRunSubagentArgs(args: unknown) {
  const record = isRecord(args) ? args : {};
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const rawTools = Array.isArray(record.tools) ? record.tools : undefined;
  const tools = rawTools
    ?.map((tool) => (typeof tool === "string" ? tool.trim() : ""))
    .filter(Boolean);
  const maxSteps = typeof record.max_steps === "number" ? record.max_steps : undefined;

  if (!description) {
    throw new RecoverableToolError(
      "Tool argument description must be a non-empty string.",
      "invalid_tool_input",
    );
  }
  if (!prompt) {
    throw new RecoverableToolError(
      "Tool argument prompt must be a non-empty string.",
      "invalid_tool_input",
    );
  }
  if (rawTools && tools?.length !== rawTools.length) {
    throw new RecoverableToolError(
      "Tool argument tools must be an array of tool-name strings.",
      "invalid_tool_input",
    );
  }

  return {
    description,
    prompt,
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
