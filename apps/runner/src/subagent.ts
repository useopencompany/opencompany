import {
  buildDeniedToolOutput,
  getAgentModelDefinition,
  getAgentModelRuntimeOptions,
  getRuntimeToolDefinition,
  type RuntimeToolDefinition,
  type RuntimeToolName,
  resolveToolDecision,
  type WorkspaceToolPolicyMap,
} from "@opencompany/agent-runtime";
import { getBraintrustAISDK, traceBraintrustStep } from "@opencompany/observability/braintrust";
import type { FinishReason, LanguageModelResponseMetadata, LanguageModelUsage } from "ai";
import * as ai from "ai";
import type { RunnerEnv } from "./env";
import { publishTransientRuntimeEvent } from "./events";
import { runFetchTranscriptTool } from "./fetch-transcript-tool";
import { executeHostedTool, type HostedToolUsage } from "./hosted-tools";
import { StaleRunLeaseError } from "./lease-writes";
import { runRecallTool } from "./recall-tool";
import type { RunControlCheck } from "./run-control";
import { runSandboxTool, type SandboxHandle } from "./sandbox";
import {
  createHostedToolBudget,
  formatRuntimePreview,
  preflightSandboxToolArgs,
} from "./tool-dispatcher";
import { recordStepUsage, recordToolUsage } from "./usage-recorder";

const SUBAGENT_MODEL_PROVIDER = "vercel-ai-gateway";
const SUBAGENT_USAGE_STEP_BASE = 1000;
const SUBAGENT_USAGE_STEP_STRIDE = 100;
const SUBAGENT_DEFAULT_MAX_STEPS = 16;
const SUBAGENT_MIN_MAX_STEPS = 4;
const SUBAGENT_MAX_MAX_STEPS = 24;
const SUBAGENT_MAX_CALLS_PER_MESSAGE = 4;
const SUBAGENT_MAX_GRANTED_TOOLS = 12;
const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
const SUBAGENT_MAX_ANSWER_CHARS = 20_000;

const NEVER_GRANTABLE_TOOL_NAMES = new Set<RuntimeToolName>([
  "run_subagent",
  "delegate_to_agent",
  "ask_user_question",
  "update_agent_file",
  "amp_coder",
  "opencode_coder",
  "gh",
  "memory",
  "inbox_list",
  "inbox_add",
  "inbox_update",
  "find_tools",
  "tool_help",
  "discover_capabilities",
]);

const DEFAULT_EXCLUDED_TOOL_NAMES = new Set<RuntimeToolName>(["write_file", "edit_file", "shell"]);

const INTERNAL_SUBAGENT_TOOL_NAMES = new Set<RuntimeToolName>(["recall", "fetch_transcript"]);

export type RunSubagentArgs = {
  description: string;
  prompt: string;
  tools?: string[] | undefined;
  model?: string | undefined;
  max_steps?: number | undefined;
};

export type RunSubagentResult = { ok: true; answer: string } | { ok: false; error: string };

type ProgressToolStatus = "running" | "completed" | "failed" | "denied";

function subagentSystemPrompt(input: { maxSteps: number; sandboxToolsGranted: boolean }) {
  return [
    "You are a focused temporary subagent running inside OpenCompany.",
    "Complete only the delegated task. Do not ask the user questions. Return one self-contained final answer for the parent agent.",
    `You have at most ${input.maxSteps} model steps. Stop as soon as you can answer well.`,
    input.sandboxToolsGranted
      ? "When using sandbox tools, paths are relative to the session workspace. Stay within the path rules described by each tool."
      : null,
    "Do not narrate tool usage unless it materially affects the answer. If a granted tool is denied by policy, take another path or report the limitation.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createRunSubagentHandler(input: {
  parentSessionId: string;
  parentMessageId: string;
  parentRunLeaseId: string;
  parentRunLeaseOwner: string;
  parentModelName: string;
  workspaceId: string;
  agentConfigBrain: RuntimeToolDispatchContext["agentConfigBrain"];
  personalAgent?: boolean;
  enabledTools: RuntimeToolName[];
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  policy: WorkspaceToolPolicyMap;
}) {
  let callCount = 0;

  return async (args: RunSubagentArgs & { toolCallId: string }): Promise<RunSubagentResult> => {
    callCount += 1;
    if (callCount > SUBAGENT_MAX_CALLS_PER_MESSAGE) {
      return {
        ok: false,
        error: `run_subagent is limited to ${SUBAGENT_MAX_CALLS_PER_MESSAGE} calls per assistant message. Summarize the subagent results you already have before starting more.`,
      };
    }

    return traceBraintrustStep(
      "subagent.run",
      () =>
        runSubagentLoop({
          ...input,
          args,
          ordinal: callCount,
        }),
      {
        parent_session_id: input.parentSessionId,
        parent_message_id: input.parentMessageId,
        tool_call_id: args.toolCallId,
        label: args.description,
      },
    );
  };
}

type RuntimeToolDispatchContext = {
  parentSessionId: string;
  parentMessageId: string;
  parentRunLeaseId: string;
  parentRunLeaseOwner: string;
  workspaceId: string;
  agentConfigBrain: Parameters<typeof preflightSandboxToolArgs>[0]["brainReferences"];
  personalAgent?: boolean;
  enabledTools: RuntimeToolName[];
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  policy: WorkspaceToolPolicyMap;
};

export async function runSubagentLoop(
  input: RuntimeToolDispatchContext & {
    parentModelName: string;
    args: RunSubagentArgs & { toolCallId: string };
    ordinal: number;
  },
): Promise<RunSubagentResult> {
  try {
    const label = input.args.description.trim();
    const prompt = input.args.prompt.trim();
    if (!label || !prompt) {
      return { ok: false, error: "description and prompt are required." };
    }

    const modelName = input.args.model?.trim() || input.parentModelName;
    if (!getAgentModelDefinition(modelName)) {
      return {
        ok: false,
        error: `Unknown model "${modelName}". Use one of: ${formatGrantableModels()}.`,
      };
    }

    const grant = resolveSubagentGrant({
      requestedTools: input.args.tools,
      enabledTools: input.enabledTools,
      personalAgent: input.personalAgent ?? false,
    });
    if (!grant.ok) {
      return { ok: false, error: grant.error };
    }

    const maxSteps = clampMaxSteps(input.args.max_steps);
    const abort = createLinkedAbortController(input.signal, SUBAGENT_TIMEOUT_MS);
    const progress = createSubagentProgressPublisher({
      sessionId: input.parentSessionId,
      messageId: input.parentMessageId,
      toolCallId: input.args.toolCallId,
      label,
    });
    const gateway = ai.createGateway({ apiKey: input.env.vercelAiGatewayApiKey });
    const { streamText } = getBraintrustAISDK(ai);
    const modelRuntime = getAgentModelRuntimeOptions(modelName);
    const toolBudget = createHostedToolBudget();
    const tools = buildSubagentTools({
      ...input,
      parentToolCallId: input.args.toolCallId,
      label,
      grantedTools: grant.tools,
      progress,
      toolBudget,
    });

    const result = streamText({
      model: gateway(modelName),
      system: subagentSystemPrompt({
        maxSteps,
        sandboxToolsGranted: grant.tools.some((tool) => tool.kind === "sandbox"),
      }),
      messages: [{ role: "user", content: prompt }],
      tools,
      stopWhen: [ai.stepCountIs(maxSteps)],
      abortSignal: abort.signal,
      ...(modelRuntime.providerOptions ? { providerOptions: modelRuntime.providerOptions } : {}),
    });

    try {
      let stepIndex = 0;
      for await (const part of result.fullStream) {
        await input.checkAbort();
        if (part.type === "text-delta") {
          progress.pushText(part.text);
        } else if (part.type === "finish-step") {
          stepIndex += 1;
          await recordSubagentStepUsage({
            context: input,
            ordinal: input.ordinal,
            innerStepIndex: stepIndex,
            modelName,
            usage: part.usage,
            response: part.response,
            finishReason: part.finishReason,
            rawFinishReason: part.rawFinishReason,
          });
        }
      }

      progress.flush();

      const answer = truncateAnswer((await result.text).trim());
      if (!answer) {
        return {
          ok: false,
          error:
            "Subagent finished without an answer. Try a more specific prompt or grant a relevant read/research tool.",
        };
      }
      return { ok: true, answer };
    } finally {
      progress.flush();
      abort.dispose();
    }
  } catch (error) {
    if (error instanceof StaleRunLeaseError) throw error;
    if (input.signal.aborted) throw error;
    return { ok: false, error: error instanceof Error ? error.message : "Subagent failed." };
  }
}

function buildSubagentTools(
  input: RuntimeToolDispatchContext & {
    parentToolCallId: string;
    label: string;
    grantedTools: RuntimeToolDefinition[];
    progress: ReturnType<typeof createSubagentProgressPublisher>;
    toolBudget: ReturnType<typeof createHostedToolBudget>;
  },
) {
  const tools: Record<string, ai.Tool> = {};
  for (const definition of input.grantedTools) {
    tools[definition.name] = ai.tool({
      description: definition.description,
      inputSchema: ai.jsonSchema(definition.parameters as Parameters<typeof ai.jsonSchema>[0]),
      execute: async (args, options) => {
        await input.checkAbort();
        const toolCallId = options.toolCallId;
        input.progress.publishTool({
          name: definition.name,
          toolCallId,
          status: "running",
          inputPreview: formatRuntimePreview(args),
        });
        try {
          const output = await dispatchSubagentTool({
            ...input,
            definition,
            args,
            innerToolCallId: toolCallId,
          });
          const denied = isDeniedToolOutput(output);
          input.progress.publishTool({
            name: definition.name,
            toolCallId,
            status: denied ? "denied" : "completed",
            outputPreview: formatRuntimePreview(output),
          });
          return output;
        } catch (error) {
          input.progress.publishTool({
            name: definition.name,
            toolCallId,
            status: "failed",
            outputPreview: error instanceof Error ? error.message : "Tool failed.",
          });
          throw error;
        }
      },
    });
  }
  return tools;
}

async function dispatchSubagentTool(
  input: RuntimeToolDispatchContext & {
    definition: RuntimeToolDefinition;
    args: unknown;
    innerToolCallId: string;
    toolBudget: ReturnType<typeof createHostedToolBudget>;
  },
) {
  const decision = resolveToolDecision({
    toolName: input.definition.name,
    toolInput: input.args,
    policy: input.policy,
    suspendable: false,
  });
  if (decision.decision === "deny") {
    return buildDeniedToolOutput({
      toolName: input.definition.name,
      providerKey: decision.providerKey,
      group: decision.group,
      source: "policy",
    });
  }

  if (input.definition.kind === "hosted") {
    const releaseBudget = input.toolBudget.reserve(input.definition);
    let usage: HostedToolUsage | undefined;
    try {
      const result = await executeHostedTool({
        name: input.definition.name,
        args: input.args,
        env: input.env,
        enabledTools: input.enabledTools,
        signal: input.signal,
        personalAgent: input.personalAgent ?? false,
        googleContext: {
          workspaceId: input.workspaceId,
          encryptionKey: input.env.integrationCredentialEncryptionKey,
          clientId: input.env.googleOAuthClientId,
          clientSecret: input.env.googleOAuthClientSecret,
        },
        neonContext: {
          workspaceId: input.workspaceId,
          encryptionKey: input.env.integrationCredentialEncryptionKey,
        },
      });
      usage = result.usage;
      return result.output;
    } finally {
      releaseBudget();
      if (usage) {
        await recordToolUsage({
          sessionId: input.parentSessionId,
          assistantMessageId: input.parentMessageId,
          runLeaseId: input.parentRunLeaseId,
          runLeaseOwner: input.parentRunLeaseOwner,
          toolCallId: input.innerToolCallId,
          toolName: input.definition.name,
          usage,
        });
      }
    }
  }

  if (input.definition.kind === "internal") {
    if (input.definition.name === "recall") {
      return runRecallTool({ sessionId: input.parentSessionId, args: input.args });
    }
    if (input.definition.name === "fetch_transcript") {
      return runFetchTranscriptTool({ callerSessionId: input.parentSessionId, args: input.args });
    }
    throw new Error(`Internal tool "${input.definition.name}" cannot be granted to a subagent.`);
  }

  preflightSandboxToolArgs({
    name: input.definition.name,
    args: input.args,
    workdir: input.workdir,
    brainReferences: input.agentConfigBrain,
    personal: input.personalAgent ?? false,
  });
  return runSandboxTool({
    sandbox: await input.getSandbox(),
    workdir: input.workdir,
    name: input.definition.name,
    args: input.args,
    personal: input.personalAgent ?? false,
  });
}

export function resolveSubagentGrant(input: {
  requestedTools?: string[] | undefined;
  enabledTools: RuntimeToolName[];
  personalAgent: boolean;
}): { ok: true; tools: RuntimeToolDefinition[] } | { ok: false; error: string } {
  const grantable = grantableToolDefinitions(input);
  const grantableNames = new Set(grantable.map((tool) => tool.name));
  const requested = input.requestedTools?.map((tool) => tool.trim()).filter(Boolean);
  const names =
    requested && requested.length > 0
      ? [...new Set(requested)]
      : grantable
          .map((tool) => tool.name)
          .filter((name) => !DEFAULT_EXCLUDED_TOOL_NAMES.has(name as RuntimeToolName))
          .slice(0, SUBAGENT_MAX_GRANTED_TOOLS);

  const invalid = names.filter((name) => !grantableNames.has(name as RuntimeToolName));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Cannot grant ${invalid.map((name) => `"${name}"`).join(", ")} to a subagent. Grantable tools are: ${[...grantableNames].join(", ") || "(none)"}.`,
    };
  }
  if (requested && requested.length > 0 && names.length > SUBAGENT_MAX_GRANTED_TOOLS) {
    return {
      ok: false,
      error: `Subagents can receive at most ${SUBAGENT_MAX_GRANTED_TOOLS} tools. Requested ${names.length}. Grantable tools are: ${[...grantableNames].join(", ") || "(none)"}.`,
    };
  }

  return {
    ok: true,
    tools: names
      .map((name) =>
        getRuntimeToolDefinition(name as RuntimeToolName, { personalAgent: input.personalAgent }),
      )
      .filter((tool): tool is RuntimeToolDefinition => Boolean(tool)),
  };
}

function grantableToolDefinitions(input: {
  enabledTools: RuntimeToolName[];
  personalAgent: boolean;
}) {
  return input.enabledTools
    .filter((name) => !NEVER_GRANTABLE_TOOL_NAMES.has(name))
    .filter((name) => !name.includes("__") && !name.startsWith("__"))
    .map((name) => getRuntimeToolDefinition(name, { personalAgent: input.personalAgent }))
    .filter((definition): definition is RuntimeToolDefinition => {
      if (!definition) return false;
      if (definition.kind === "internal") return INTERNAL_SUBAGENT_TOOL_NAMES.has(definition.name);
      return true;
    });
}

function clampMaxSteps(value: number | undefined) {
  if (!Number.isFinite(value)) return SUBAGENT_DEFAULT_MAX_STEPS;
  const numericValue = value ?? SUBAGENT_DEFAULT_MAX_STEPS;
  return Math.max(
    SUBAGENT_MIN_MAX_STEPS,
    Math.min(SUBAGENT_MAX_MAX_STEPS, Math.floor(numericValue)),
  );
}

function formatGrantableModels() {
  return "a supported agent model from the model picker";
}

function createLinkedAbortController(parentSignal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Subagent timed out.")), timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abort);
    },
  };
}

function createSubagentProgressPublisher(input: {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  label: string;
}) {
  let pending = "";
  let lastFlushAt = Date.now();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (!pending) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    const delta = pending;
    pending = "";
    lastFlushAt = Date.now();
    publishTransientRuntimeEvent({
      sessionId: input.sessionId,
      messageId: input.messageId,
      type: "subagent.progress",
      payload: {
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        label: input.label,
        kind: "text-delta",
        delta,
      },
    });
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, 250);
    flushTimer.unref?.();
  };

  return {
    pushText(delta: string) {
      if (!delta) return;
      pending += delta;
      if (pending.length >= 1024 || Date.now() - lastFlushAt >= 250) {
        flush();
      } else {
        scheduleFlush();
      }
    },
    publishTool(inputTool: {
      name: string;
      toolCallId: string;
      status: ProgressToolStatus;
      inputPreview?: string | undefined;
      outputPreview?: string | undefined;
    }) {
      flush();
      publishTransientRuntimeEvent({
        sessionId: input.sessionId,
        messageId: input.messageId,
        type: "subagent.progress",
        payload: {
          messageId: input.messageId,
          toolCallId: input.toolCallId,
          label: input.label,
          kind: inputTool.status === "running" ? "tool-call" : "tool-result",
          tool: {
            name: inputTool.name,
            toolCallId: inputTool.toolCallId,
            status: inputTool.status,
            ...(inputTool.inputPreview !== undefined
              ? { inputPreview: inputTool.inputPreview }
              : {}),
            ...(inputTool.outputPreview !== undefined
              ? { outputPreview: inputTool.outputPreview }
              : {}),
          },
        },
      });
    },
    flush,
  };
}

async function recordSubagentStepUsage(input: {
  context: RuntimeToolDispatchContext;
  ordinal: number;
  innerStepIndex: number;
  modelName: string;
  usage: LanguageModelUsage;
  response: LanguageModelResponseMetadata;
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
}) {
  await recordStepUsage({
    sessionId: input.context.parentSessionId,
    assistantMessageId: input.context.parentMessageId,
    runLeaseId: input.context.parentRunLeaseId,
    runLeaseOwner: input.context.parentRunLeaseOwner,
    stepIndex:
      SUBAGENT_USAGE_STEP_BASE + input.ordinal * SUBAGENT_USAGE_STEP_STRIDE + input.innerStepIndex,
    modelProvider: SUBAGENT_MODEL_PROVIDER,
    modelName: input.modelName,
    response: input.response,
    usage: input.usage,
    finishReason: input.finishReason,
    rawFinishReason: input.rawFinishReason,
  });
}

function truncateAnswer(answer: string) {
  if (answer.length <= SUBAGENT_MAX_ANSWER_CHARS) return answer;
  return `${answer.slice(0, SUBAGENT_MAX_ANSWER_CHARS)}\n\n[Subagent answer truncated]`;
}

function isDeniedToolOutput(value: unknown) {
  return Boolean(value && typeof value === "object" && "denied" in value);
}
