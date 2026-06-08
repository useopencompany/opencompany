import {
  coerceToolArgs,
  type ToolArgError,
  type ToolArgResolution,
  toFailureClasses,
  validateToolArgs,
} from "@opencompany/agent-runtime";
import { createLogger } from "@opencompany/observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import * as ai from "ai";
import { createGateway, jsonSchema } from "ai";

// The model-independent argument-resolution pipeline every deferred-tool dispatch runs through.
// Deferred tools (use_tool / {server}__use_tool) bypass the provider's structured decoding, so the
// inner arguments arrive unenforced. This restores a deterministic gate and a cheap repair path:
//
//   Layer 1  validate against the resolved JSON Schema (the gate)
//   Layer 2  safe, lossless coercion (no model) — parse/unwrap/narrow/normalize, then re-validate
//   Layer 3  small repair model — reshape-only, re-validated; never trusted, never invents data
//   Layer 4  (caller) surface the existing recoverable error so the *main* model self-retries
//
// The same path runs for every agent regardless of which main model is in use.

const logger = createLogger({ service: "opencompany-runner" });

// Fixed small model for Layer 3 — mirrors session-title's lightweight model. Configurable here
// (not per-agent) so the repair behaviour is identical across all main models.
export const TOOL_ARG_REPAIR_MODEL = "openai/gpt-5.4-mini";

// Repair is a best-effort side call on a failure path; keep it tight so a slow/unavailable model
// never stalls the turn. On timeout we fall through to the deterministic error.
const REPAIR_TIMEOUT_MS = 8_000;
const REPAIR_MAX_OUTPUT_TOKENS = 800;
// Cap the schema/args we inline into the repair prompt so a pathological payload can't blow up the
// request. Repair operates on small argument objects in practice.
const REPAIR_PROMPT_CHAR_BUDGET = 6_000;

export type ToolArgRepairConfig = {
  // Gateway API key. When absent, Layer 3 is skipped (Layers 1–2 always run).
  apiKey?: string | undefined;
  // Kill switch. When false, Layer 3 is skipped.
  enabled?: boolean | undefined;
  model?: string | undefined;
};

export type PrepareToolArgsInput = {
  surface: "builtin" | "mcp";
  toolName: string;
  schema: unknown;
  rawArgs: unknown;
  repair?: ToolArgRepairConfig | undefined;
  signal?: AbortSignal | undefined;
  // Optional context for telemetry/logging only.
  observability?:
    | {
        sessionId?: string;
        workspaceId?: string;
        agentId?: string;
        modelName?: string;
      }
    | undefined;
};

export type PrepareToolArgsResult =
  | { ok: true; args: unknown; resolution: ToolArgResolution }
  | { ok: false; errors: ToolArgError[]; resolution: ToolArgResolution };

export async function prepareToolArgs(input: PrepareToolArgsInput): Promise<PrepareToolArgsResult> {
  const { surface, schema, rawArgs } = input;

  // Layer 1 — deterministic validation.
  const initialErrors = validateToolArgs(schema, rawArgs);
  if (initialErrors.length === 0) {
    return { ok: true, args: rawArgs, resolution: { surface, outcome: "valid" } };
  }
  const failureClasses = toFailureClasses(initialErrors);

  // Layer 2 — safe deterministic coercion, then re-validate. Only accept if it fully passes.
  const { args: coercedArgs, coercions } = coerceToolArgs(schema, rawArgs);
  const coercedErrors =
    coercions.length > 0 ? validateToolArgs(schema, coercedArgs) : initialErrors;
  if (coercions.length > 0 && coercedErrors.length === 0) {
    return {
      ok: true,
      args: coercedArgs,
      resolution: { surface, outcome: "coerced", failureClasses, coercions },
    };
  }

  // Layer 3 — small repair model. Only when enabled and we have a key. Operates on the best
  // current attempt (coerced args) plus the remaining errors. The result is always re-validated.
  const repairEnabled = input.repair?.enabled !== false && Boolean(input.repair?.apiKey);
  if (repairEnabled && input.repair?.apiKey) {
    const model = input.repair.model ?? TOOL_ARG_REPAIR_MODEL;
    const repaired = await repairToolArgs({
      toolName: input.toolName,
      schema,
      args: coercedArgs,
      errors: coercedErrors,
      apiKey: input.repair.apiKey,
      model,
      signal: input.signal,
      observability: input.observability,
    });
    if (repaired.ok) {
      const repairedErrors = validateToolArgs(schema, repaired.args);
      if (repairedErrors.length === 0) {
        return {
          ok: true,
          args: repaired.args,
          resolution: {
            surface,
            outcome: "repaired",
            failureClasses,
            ...(coercions.length > 0 ? { coercions } : {}),
            repairModel: model,
          },
        };
      }
    }
    // Repair ran but couldn't produce schema-valid args — record that distinctly so telemetry can
    // tell "repair fired and lost" apart from "repair never ran".
    return {
      ok: false,
      errors: coercedErrors,
      resolution: {
        surface,
        outcome: "repair_failed",
        failureClasses,
        ...(coercions.length > 0 ? { coercions } : {}),
        repairModel: model,
      },
    };
  }

  // Layers 1–2 failed and Layer 3 was disabled/unavailable: hand back the deterministic errors.
  return {
    ok: false,
    errors: coercedErrors,
    resolution: {
      surface,
      outcome: "errored",
      failureClasses,
      ...(coercions.length > 0 ? { coercions } : {}),
    },
  };
}

const REPAIR_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    unrepairable: {
      type: "boolean",
      description:
        "Set true when a required value is genuinely missing and cannot be inferred from the given arguments. Do not guess.",
    },
    reason: {
      type: "string",
      description: "Short explanation when unrepairable is true.",
    },
    arguments: {
      type: "object",
      additionalProperties: true,
      description: "The repaired arguments object that satisfies the tool's input schema.",
    },
  },
  required: [],
} as const;

type RepairResult = { ok: true; args: unknown } | { ok: false; reason: string };

async function repairToolArgs(input: {
  toolName: string;
  schema: unknown;
  args: unknown;
  errors: ToolArgError[];
  apiKey: string;
  model: string;
  signal?: AbortSignal | undefined;
  observability?: PrepareToolArgsInput["observability"];
}): Promise<RepairResult> {
  const abort = withTimeout(input.signal, REPAIR_TIMEOUT_MS);
  try {
    const gateway = createGateway({ apiKey: input.apiKey });
    // Traced by Braintrust's `wrapAISDK` when enabled; falls back to the unwrapped `ai` otherwise.
    const { generateObject } = getBraintrustAISDK(ai);
    const result = await generateObject({
      model: gateway(input.model),
      schema: jsonSchema(REPAIR_OUTPUT_SCHEMA as never),
      system:
        "You repair malformed tool-call arguments. You are given a tool's JSON Schema, the " +
        "arguments a larger model produced, and the validation errors. Return arguments that " +
        "satisfy the schema by reshaping ONLY what is present: fix value types, rename an " +
        "obviously misnamed field to the correct schema field, restructure nesting, and normalize " +
        "enum casing. NEVER invent values for missing required fields you cannot infer from the " +
        "provided arguments — if a required value is genuinely absent, return unrepairable=true " +
        "with a short reason instead of guessing.",
      prompt: buildRepairPrompt(input),
      maxOutputTokens: REPAIR_MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: abort.signal,
    });

    const object = result.object as {
      unrepairable?: boolean;
      reason?: string;
      arguments?: unknown;
    };
    if (object.unrepairable === true) {
      return { ok: false, reason: object.reason ?? "model reported unrepairable" };
    }
    if (object.arguments === undefined) {
      return { ok: false, reason: "repair returned no arguments" };
    }
    return { ok: true, args: object.arguments };
  } catch (error) {
    // A failed repair must never break the turn — fall through to the deterministic error.
    logger.warn("tool argument repair failed", {
      event: "opencompany.runner_tool_arg_repair_failed",
      tool_name: input.toolName,
      repair_model: input.model,
      session_id: input.observability?.sessionId,
      workspace_id: input.observability?.workspaceId,
      agent_id: input.observability?.agentId,
      error,
    });
    return { ok: false, reason: error instanceof Error ? error.message : "repair model failed" };
  } finally {
    abort.dispose();
  }
}

function buildRepairPrompt(input: {
  toolName: string;
  schema: unknown;
  args: unknown;
  errors: ToolArgError[];
}): string {
  const schemaText = clip(safeJson(input.schema));
  const argsText = clip(safeJson(input.args));
  const errorList = input.errors.map((error) => `- ${error.message}`).join("\n");
  return [
    `Tool: ${input.toolName}`,
    "",
    "Input JSON Schema:",
    schemaText,
    "",
    "Arguments produced (invalid):",
    argsText,
    "",
    "Validation errors:",
    errorList,
  ].join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

function clip(text: string): string {
  return text.length <= REPAIR_PROMPT_CHAR_BUDGET
    ? text
    : `${text.slice(0, REPAIR_PROMPT_CHAR_BUDGET)}\n… (truncated)`;
}

// Combine the run's abort signal with a repair-specific timeout. Returns a disposable so the timer
// is always cleared. AbortSignal.any/timeout are available on Node 20+ (runner is Node 24).
function withTimeout(
  signal: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return { signal: timeout, dispose: () => {} };
  const combined = AbortSignal.any([signal, timeout]);
  return { signal: combined, dispose: () => {} };
}
