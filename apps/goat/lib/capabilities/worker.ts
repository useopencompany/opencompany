import {
  type GoatGatewayAttribution,
  goatGatewayProviderOptions,
} from "@opencompany/goat-observability";
import {
  createGateway,
  generateObject,
  generateText,
  jsonSchema,
  type LanguageModelUsage,
  stepCountIs,
  type Tool,
  type ToolSet,
} from "ai";
import {
  GoatCapabilityAuthError,
  type GoatCapabilityCallDebug,
  type GoatCapabilityEnvelope,
  type GoatCapabilityErrorCode,
  type GoatCapabilityTranscriptEntry,
  type GoatCapabilityWorkerContext,
  type ResolvedGoatCapability,
} from "@/lib/capabilities/types";

export const WORKER_MAX_STEPS = 5;
export const WORKER_LOOP_TIMEOUT_MS = 25_000;
export const WORKER_FINALIZE_TIMEOUT_MS = 8_000;
export const ENVELOPE_MAX_SUMMARY_CHARS = 1_200;
export const ENVELOPE_MAX_ENTITIES = 8;
const TRANSCRIPT_PREVIEW_CHARS = 1_500;
const FINAL_TEXT_MAX_CHARS = 4_000;

type GenerateTextLike = typeof generateText;
type GenerateObjectLike = typeof generateObject;

type WorkerRunStatus = "completed" | "step_cap" | "timeout" | "error";

export type GoatCapabilityWorkerResult = {
  envelope: GoatCapabilityEnvelope;
  debug: GoatCapabilityCallDebug;
  usage: LanguageModelUsage;
};

// Error codes the finalizer model may emit; the rest of the taxonomy is only
// ever attached by code (auth, budget, and infrastructure failures).
const MODEL_ERROR_CODES = [
  "timeout",
  "step_cap",
  "provider_error",
  "invalid_request",
  "empty_result",
] as const;

// OpenAI strict structured outputs require EVERY property key to appear in
// `required`; optionality is expressed as a null union instead. clampEnvelope
// strips the nulls back out before the envelope crosses to the main model.
const ENVELOPE_JSON_SCHEMA = jsonSchema<GoatCapabilityEnvelope>({
  type: "object",
  additionalProperties: false,
  required: ["summary", "entities", "error"],
  properties: {
    summary: {
      type: "string",
      description:
        "Concise answer to the request, written for the assistant that dispatched it. Plain prose, under 1200 characters, no markdown headers.",
    },
    entities: {
      type: "array",
      maxItems: ENVELOPE_MAX_ENTITIES,
      description:
        "Provider objects the summary relies on, with stable ids so follow-up requests can reference them without re-fetching.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "id", "url", "title"],
        properties: {
          type: {
            type: "string",
            description: 'Entity kind, e.g. "slack_message", "linear_issue", "youtube_video".',
          },
          id: { type: "string", description: "Stable provider id (channel:ts, issue key, …)." },
          url: {
            type: ["string", "null"],
            description: "Direct link to the entity, or null when unknown.",
          },
          title: {
            type: ["string", "null"],
            description: "Short human-readable label, or null.",
          },
        },
      },
    },
    error: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["code", "hint"],
      description: "Null when the request was answered normally.",
      properties: {
        code: { type: "string", enum: [...MODEL_ERROR_CODES] },
        hint: {
          type: "string",
          description:
            "Written FOR the assistant reading this result: what to tell the user or do next.",
        },
      },
    },
  },
});

export async function runGoatCapabilityWorker(input: {
  capability: ResolvedGoatCapability;
  request: string;
  context: GoatCapabilityWorkerContext;
  gatewayApiKey: string;
  attribution: GoatGatewayAttribution;
  generateTextImpl?: GenerateTextLike;
  generateObjectImpl?: GenerateObjectLike;
}): Promise<GoatCapabilityWorkerResult> {
  const startedAt = Date.now();
  const transcript: GoatCapabilityTranscriptEntry[] = [];
  const usage = createEmptyUsage();
  let steps = 0;

  const finish = (
    envelope: GoatCapabilityEnvelope,
    outcome: GoatCapabilityCallDebug["outcome"],
  ): GoatCapabilityWorkerResult => ({
    envelope,
    usage,
    debug: {
      capability: input.capability.id,
      operation: input.context.operation,
      workerModel: input.capability.workerModel,
      steps,
      durationMs: Date.now() - startedAt,
      outcome,
      ...(envelope.error ? { errorCode: envelope.error.code } : {}),
      transcript,
    },
  });

  if (input.context.operation === "write" && input.capability.sideEffect !== "write") {
    return finish(
      errorEnvelope(
        "invalid_request",
        `The ${input.capability.id} capability does not support write operations.`,
      ),
      "error",
    );
  }

  const loopController = new AbortController();
  const timeoutHandle = setTimeout(() => loopController.abort(), WORKER_LOOP_TIMEOUT_MS);
  const onParentAbort = () => loopController.abort();
  if (input.context.signal.aborted) loopController.abort();
  else input.context.signal.addEventListener("abort", onParentAbort, { once: true });
  const stopLoopTimer = () => {
    clearTimeout(timeoutHandle);
    input.context.signal.removeEventListener("abort", onParentAbort);
  };

  let toolkit: Awaited<ReturnType<ResolvedGoatCapability["createTools"]>>;
  try {
    toolkit = await input.capability.createTools({
      ...input.context,
      signal: loopController.signal,
    });
  } catch (error) {
    stopLoopTimer();
    if (loopController.signal.aborted) {
      return finish(
        errorEnvelope(
          "timeout",
          `The ${input.capability.id} lookup was cancelled before its tools were ready; suggest retrying or narrowing the request.`,
        ),
        "error",
      );
    }
    const code: GoatCapabilityErrorCode =
      error instanceof GoatCapabilityAuthError ? error.code : "internal";
    return finish(
      errorEnvelope(
        code,
        error instanceof GoatCapabilityAuthError
          ? error.message
          : `The ${input.capability.id} capability could not start; suggest trying again or checking the connection in Settings → Integrations.`,
      ),
      "error",
    );
  }

  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  const generateTextImpl = input.generateTextImpl ?? generateText;
  const generateObjectImpl = input.generateObjectImpl ?? generateObject;
  const providerOptions = goatGatewayProviderOptions(input.attribution);

  let status: WorkerRunStatus = "completed";
  let finalText = "";
  try {
    const result = await generateTextImpl({
      model: gateway(input.capability.workerModel),
      system: workerSystemPrompt(input.capability, input.context),
      prompt: input.request,
      tools: withTranscript(toolkit.tools, transcript),
      stopWhen: stepCountIs(WORKER_MAX_STEPS),
      abortSignal: loopController.signal,
      providerOptions,
      onStepFinish(step) {
        steps += 1;
        addUsage(usage, step.usage);
      },
    });
    finalText = result.text ?? "";
    if (steps >= WORKER_MAX_STEPS && result.finishReason !== "stop") {
      status = "step_cap";
    }
  } catch (error) {
    if (loopController.signal.aborted) {
      status = "timeout";
    } else {
      status = "error";
      if (transcript.length === 0) {
        return finish(
          errorEnvelope(
            "provider_error",
            `The ${input.capability.id} lookup failed before it could gather anything (${errorMessage(error)}); a retry or a narrower request may work.`,
          ),
          "error",
        );
      }
    }
  } finally {
    stopLoopTimer();
    await closeToolkit(toolkit);
  }

  // Nothing gathered and nothing said: no material for a model finalizer.
  if (transcript.length === 0 && finalText.trim() === "") {
    return finish(
      errorEnvelope(
        status === "timeout" ? "timeout" : "empty_result",
        status === "timeout"
          ? `The ${input.capability.id} lookup timed out before gathering anything; suggest retrying or narrowing the request.`
          : `The ${input.capability.id} lookup produced nothing; the request may need to be more specific.`,
      ),
      "error",
    );
  }

  // The chat turn itself is gone — skip the finalizer model call.
  if (input.context.signal.aborted) {
    return finish(
      errorEnvelope("timeout", "The chat turn was aborted before this lookup finished."),
      "error",
    );
  }

  try {
    const finalized = await generateObjectImpl({
      model: gateway(input.capability.workerModel),
      schema: ENVELOPE_JSON_SCHEMA,
      system: FINALIZER_SYSTEM_PROMPT,
      prompt: finalizerPrompt(input.request, status, finalText, transcript),
      abortSignal: AbortSignal.timeout(WORKER_FINALIZE_TIMEOUT_MS),
      providerOptions,
    });
    addUsage(usage, finalized.usage);
    const envelope = clampEnvelope(finalized.object as GoatCapabilityEnvelope, status);
    return finish(envelope, envelope.error ? "partial" : "success");
  } catch (error) {
    // The data is already gathered — never throw it away because the envelope
    // model call failed. The worker's plain-text answer becomes the summary
    // (losing structured entities, keeping the substance).
    if (finalText.trim()) {
      const envelope = clampEnvelope({ summary: finalText, entities: [] }, status);
      return finish(envelope, "partial");
    }
    return finish(
      errorEnvelope(
        status === "timeout" ? "timeout" : status === "step_cap" ? "step_cap" : "provider_error",
        `The ${input.capability.id} lookup gathered data but could not summarize it (${errorMessage(error)}); suggest retrying with a narrower request.`,
      ),
      "error",
    );
  }
}

function workerSystemPrompt(
  capability: ResolvedGoatCapability,
  context: GoatCapabilityWorkerContext,
) {
  const user = context.userContext;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "unknown";
  const operationLines =
    context.operation === "write"
      ? [
          `You are a focused worker executing one explicitly requested change against the ${capability.id} capability.`,
          "This call is authorized for writes, but only the exact external changes stated in the request. Do not add, broaden, or infer other mutations.",
          "If a material target or value is ambiguous, do not mutate it. State what is missing in your answer; no one can answer questions inside this worker run.",
          "Never retry a mutation after an error or an ambiguous result. Report each completed change with its provider id and url.",
        ]
      : [
          `You are a focused read-only worker executing one request against the ${capability.id} capability.`,
          "All tools are read-only; you cannot change anything.",
        ];
  return [
    ...operationLines,
    `You have at most ${WORKER_MAX_STEPS} tool steps; prefer the fewest calls that answer the request.`,
    "Never ask questions — no one will answer. Make the best reasonable interpretation of the request.",
    "When you have what you need, stop calling tools and write your findings as plain text: the direct answer first, then the provider ids and urls of everything you cited.",
    "<recipes>",
    ...capability.recipeLines,
    "</recipes>",
    "<context>",
    `Requesting user: ${name} (${user.email}), timezone ${user.timezone}.`,
    `Current date: ${context.currentDate.toISOString().slice(0, 10)}.`,
    "</context>",
  ].join("\n");
}

const FINALIZER_SYSTEM_PROMPT = [
  "You compact a worker agent's findings into a structured result for the assistant that dispatched it.",
  "The summary must answer the original request from the findings — do not invent anything the transcript does not support.",
  "When the request changed provider state, say exactly what was created or changed and do not claim success without a successful tool result.",
  "List every provider object the summary relies on in entities, with stable ids and urls taken verbatim from the transcript.",
  "If the run was cut off (status step_cap or timeout), summarize what WAS found and set error to that status code with a hint saying the result is partial.",
  "If the findings do not answer the request, set error code empty_result with a hint about what would help.",
].join("\n");

function finalizerPrompt(
  request: string,
  status: WorkerRunStatus,
  finalText: string,
  transcript: GoatCapabilityTranscriptEntry[],
) {
  const lines = [
    `<request>${request}</request>`,
    `<run_status>${status}</run_status>`,
    "<worker_answer>",
    truncate(finalText, FINAL_TEXT_MAX_CHARS) || "(none)",
    "</worker_answer>",
    "<tool_transcript>",
  ];
  transcript.forEach((entry, index) => {
    lines.push(
      `${index + 1}. ${entry.tool} (${entry.durationMs}ms)`,
      `   input: ${entry.inputPreview}`,
      `   output: ${entry.outputPreview}`,
    );
  });
  lines.push("</tool_transcript>");
  return lines.join("\n");
}

// Tool wrapper: records a bounded transcript for the finalizer + debug trace,
// and converts tool failures into error results so one bad call doesn't kill
// the loop.
function withTranscript(tools: ToolSet, transcript: GoatCapabilityTranscriptEntry[]): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute?.bind(definition);
    if (!execute) {
      wrapped[name] = definition;
      continue;
    }
    wrapped[name] = {
      ...definition,
      execute: async (args: unknown, options: unknown) => {
        const startedAt = Date.now();
        try {
          const output = await execute(args as never, options as never);
          transcript.push({
            tool: name,
            durationMs: Date.now() - startedAt,
            inputPreview: preview(args),
            outputPreview: preview(output),
          });
          return output;
        } catch (error) {
          const failure = { error: errorMessage(error) };
          transcript.push({
            tool: name,
            durationMs: Date.now() - startedAt,
            inputPreview: preview(args),
            outputPreview: preview(failure),
          });
          return failure;
        }
      },
    } as Tool;
  }
  return wrapped;
}

export function clampEnvelope(
  raw: GoatCapabilityEnvelope,
  status: WorkerRunStatus,
): GoatCapabilityEnvelope {
  const entities = (Array.isArray(raw.entities) ? raw.entities : [])
    .filter((entity) => typeof entity?.type === "string" && typeof entity?.id === "string")
    .slice(0, ENVELOPE_MAX_ENTITIES)
    .map((entity) => ({
      type: entity.type,
      id: entity.id,
      ...(isHttpUrl(entity.url) ? { url: entity.url } : {}),
      ...(typeof entity.title === "string" ? { title: truncate(entity.title, 120) } : {}),
    }));

  let error = raw.error;
  if (error) {
    const code = (MODEL_ERROR_CODES as readonly string[]).includes(error.code)
      ? error.code
      : "provider_error";
    error = { code: code as GoatCapabilityErrorCode, hint: truncate(error.hint ?? "", 400) };
  } else if (status === "step_cap" || status === "timeout") {
    // A capped run is partial even when the finalizer forgot to say so.
    error = {
      code: status,
      hint: "The lookup hit its budget; this summary covers only what was gathered in time.",
    };
  }

  return {
    summary: truncate(
      typeof raw.summary === "string" ? raw.summary : "",
      ENVELOPE_MAX_SUMMARY_CHARS,
    ),
    entities,
    ...(error ? { error } : {}),
  };
}

function errorEnvelope(code: GoatCapabilityErrorCode, hint: string): GoatCapabilityEnvelope {
  return { summary: "", entities: [], error: { code, hint } };
}

async function closeToolkit(toolkit: { close?: () => Promise<void> }) {
  await toolkit.close?.().catch(() => {});
}

function createEmptyUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
  };
}

function addUsage(total: LanguageModelUsage, step: LanguageModelUsage | undefined) {
  if (!step) return;
  total.inputTokens = (total.inputTokens ?? 0) + (step.inputTokens ?? 0);
  total.outputTokens = (total.outputTokens ?? 0) + (step.outputTokens ?? 0);
  total.totalTokens = (total.totalTokens ?? 0) + (step.totalTokens ?? 0);
  total.inputTokenDetails.noCacheTokens =
    (total.inputTokenDetails.noCacheTokens ?? 0) + (step.inputTokenDetails?.noCacheTokens ?? 0);
  total.inputTokenDetails.cacheReadTokens =
    (total.inputTokenDetails.cacheReadTokens ?? 0) + (step.inputTokenDetails?.cacheReadTokens ?? 0);
  total.inputTokenDetails.cacheWriteTokens =
    (total.inputTokenDetails.cacheWriteTokens ?? 0) +
    (step.inputTokenDetails?.cacheWriteTokens ?? 0);
  total.outputTokenDetails.textTokens =
    (total.outputTokenDetails.textTokens ?? 0) + (step.outputTokenDetails?.textTokens ?? 0);
  total.outputTokenDetails.reasoningTokens =
    (total.outputTokenDetails.reasoningTokens ?? 0) +
    (step.outputTokenDetails?.reasoningTokens ?? 0);
}

function preview(value: unknown) {
  try {
    return truncate(JSON.stringify(value) ?? "undefined", TRANSCRIPT_PREVIEW_CHARS);
  } catch {
    return "[unserializable]";
  }
}

function truncate(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
