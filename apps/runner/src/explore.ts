import { getAgentModelRuntimeOptions } from "@opencompany/agent-runtime";
import { getBraintrustAISDK, traceBraintrustStep } from "@opencompany/observability/braintrust";
import type { FinishReason, LanguageModelResponseMetadata, LanguageModelUsage } from "ai";
import * as ai from "ai";
import type { RunnerEnv } from "./env";
import { publishTransientRuntimeEvent } from "./events";
import { StaleRunLeaseError } from "./lease-writes";
import type { RunControlCheck } from "./run-control";
import { runSandboxTool, type SandboxHandle } from "./sandbox";
import { recordStepUsage } from "./usage-recorder";

// Explore always runs on a fast, cheap model: it does read-heavy navigation and only needs
// to distill what it finds, so a smaller model keeps the parent turn affordable.
const EXPLORE_MODEL_ID = "anthropic/claude-haiku-4.5";
const EXPLORE_MODEL_PROVIDER = "vercel-ai-gateway";

// Inner usage rows are attributed to the parent message. There is no unique constraint on
// (message, stepIndex), so this offset is cosmetic only — it keeps explore steps visually
// distinct from the parent turn's own steps in usage analytics.
const EXPLORE_USAGE_STEP_BASE = 1000;

export type ExploreScope = "brain" | "work" | "all";
export type ExploreBreadth = "quick" | "thorough";

export type ExploreHandlerResult = { ok: true; summary: string } | { ok: false; error: string };

const READ_FILE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Relative path starting with work/, brain/, or agent/." },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const LIST_FILES_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Relative path starting with work/, brain/, or agent/.",
      default: "brain",
    },
    depth: { type: "number", description: "Maximum traversal depth.", default: 2 },
  },
  additionalProperties: false,
} as const;

const GREP_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "A read-only search command (rg/grep/ls/find/cat/head/tail). Paths must stay under your allowed roots.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

function exploreSystemPrompt(scope: ExploreScope): string {
  const roots =
    scope === "brain" ? "brain/" : scope === "work" ? "work/" : "brain/, work/, and agent/";
  return [
    "You are a read-only research sub-agent running inside an OpenCompany sandbox.",
    "Another agent has delegated a focused lookup to you. Investigate it by reading files, then report back.",
    `You may only read under: ${roots}. Every path you pass to a tool must start with one of those prefixes (e.g. brain/README.md).`,
    "Shared company knowledge lives under brain/. Start broad with list_files and grep, then read only the few most relevant files — do not read everything.",
    "You are strictly read-only: you cannot edit, write, install, fetch from the network, mutate git, or ask the user anything. The grep tool runs read-only searches only (rg/grep/ls/find/cat/head/tail).",
    "Respect your step budget and stop exploring as soon as you can answer.",
    "End with ONE concise summary that directly answers the task: the facts that matter, each with the file path you found it in. No preamble, no narration of your tool calls. If you found nothing relevant, say so plainly. Aim for a few hundred words at most.",
  ].join("\n");
}

// Runs the explore sub-agent loop: a self-contained streamText call in its own context window,
// on the SAME sandbox as the parent. Deliberately does NOT reuse createToolSet's tools (which
// block on the parent's toolStartCoordinator and persist into the parent transcript) — the inner
// tools are plain wrappers around runSandboxTool so the only parent-visible artifact is the single
// explore tool result. Returns the final distilled summary text.
export async function runExplore(input: {
  task: string;
  scope: ExploreScope;
  breadth: ExploreBreadth;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  onProgress?: (delta: string) => void;
  onUsageStep?: (step: {
    stepIndex: number;
    usage: LanguageModelUsage;
    response: LanguageModelResponseMetadata;
    finishReason: FinishReason;
    rawFinishReason: string | undefined;
  }) => Promise<void>;
}): Promise<string> {
  const gateway = ai.createGateway({ apiKey: input.env.vercelAiGatewayApiKey });
  const { streamText } = getBraintrustAISDK(ai);
  const modelRuntime = getAgentModelRuntimeOptions(EXPLORE_MODEL_ID);

  const sandboxTool = (
    name: "read_file" | "list_files" | "shell",
    description: string,
    schema: unknown,
  ) =>
    ai.tool({
      description,
      inputSchema: ai.jsonSchema(schema as Parameters<typeof ai.jsonSchema>[0]),
      execute: async (args) => {
        await input.checkAbort();
        return runSandboxTool({
          sandbox: await input.getSandbox(),
          workdir: input.workdir,
          name,
          args,
        });
      },
    });

  const tools = {
    read_file: sandboxTool(
      "read_file",
      "Read a UTF-8 text file under your allowed roots.",
      READ_FILE_SCHEMA,
    ),
    list_files: sandboxTool(
      "list_files",
      "List files and directories under your allowed roots.",
      LIST_FILES_SCHEMA,
    ),
    grep: sandboxTool(
      "shell",
      "Run a read-only search command (rg/grep/ls/find/cat/head/tail) under your allowed roots.",
      GREP_SCHEMA,
    ),
  };

  const result = streamText({
    model: gateway(EXPLORE_MODEL_ID),
    system: exploreSystemPrompt(input.scope),
    messages: [{ role: "user", content: input.task }],
    tools,
    stopWhen: [ai.stepCountIs(input.breadth === "thorough" ? 24 : 10)],
    abortSignal: input.signal,
    ...(modelRuntime.providerOptions ? { providerOptions: modelRuntime.providerOptions } : {}),
  });

  let stepIndex = 0;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      input.onProgress?.(part.text);
    } else if (part.type === "finish-step") {
      stepIndex += 1;
      await input.onUsageStep?.({
        stepIndex,
        usage: part.usage,
        response: part.response,
        finishReason: part.finishReason,
        rawFinishReason: part.rawFinishReason,
      });
    }
  }

  return (await result.text).trim();
}

// Factory mirroring createAgentDelegationHandler: closes over the parent turn context and returns
// the function the tool dispatcher invokes for an `explore` tool call.
export function createExploreHandler(input: {
  parentSessionId: string;
  parentMessageId: string;
  parentRunLeaseId: string;
  parentRunLeaseOwner: string;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
}) {
  return async ({
    task,
    scope = "brain",
    breadth = "quick",
    toolCallId,
  }: {
    task: string;
    scope?: ExploreScope;
    breadth?: ExploreBreadth;
    toolCallId: string;
  }): Promise<ExploreHandlerResult> => {
    try {
      const summary = await traceBraintrustStep(
        "explore.run",
        () =>
          runExplore({
            task,
            scope,
            breadth,
            getSandbox: input.getSandbox,
            workdir: input.workdir,
            env: input.env,
            signal: input.signal,
            checkAbort: input.checkAbort,
            onProgress: (delta) =>
              publishTransientRuntimeEvent({
                sessionId: input.parentSessionId,
                messageId: input.parentMessageId,
                type: "command.output",
                payload: { command: "explore", toolCallId, stream: "stdout", delta },
              }),
            // Roll the sub-agent's model usage into the parent turn so it is billed and shown as
            // part of this assistant message's cost.
            onUsageStep: (step) =>
              recordStepUsage({
                sessionId: input.parentSessionId,
                assistantMessageId: input.parentMessageId,
                runLeaseId: input.parentRunLeaseId,
                runLeaseOwner: input.parentRunLeaseOwner,
                stepIndex: EXPLORE_USAGE_STEP_BASE + step.stepIndex,
                modelProvider: EXPLORE_MODEL_PROVIDER,
                modelName: EXPLORE_MODEL_ID,
                response: step.response,
                usage: step.usage,
                finishReason: step.finishReason,
                rawFinishReason: step.rawFinishReason,
              }),
          }),
        {
          parent_session_id: input.parentSessionId,
          parent_message_id: input.parentMessageId,
          tool_call_id: toolCallId,
          scope,
          breadth,
        },
      );
      if (!summary) {
        return {
          ok: false,
          error:
            "Explore finished without a summary. Try a more specific task or a different scope.",
        };
      }
      return { ok: true, summary };
    } catch (error) {
      // Lease loss and parent aborts must unwind the run, not collapse into a tool result.
      if (error instanceof StaleRunLeaseError) throw error;
      if (input.signal.aborted) throw error;
      return { ok: false, error: error instanceof Error ? error.message : "Explore failed." };
    }
  };
}
