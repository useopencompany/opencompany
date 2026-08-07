import {
  BRAIN_READ_COMMANDS,
  BRAIN_RETRIEVAL_COMMANDS as BRAIN_READ_PLANE_COMMANDS,
  BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  BRAIN_TOOL_FLAG_VALUE_JSON_SCHEMA,
  normalizeBrainReadToolInput as normalizeSharedBrainReadToolInput,
} from "@opencompany/brain";
import type { BrainToolInput } from "./chat-ui";

// Shared read-only Goat Brain tool surface for main chat and the per-brain MCP connector.
// Keep command and input normalization here so both consumers expose the same retrieval contract.
// Commands served by the DB read plane (@opencompany/db/brain-read): indexed SQL, no brain
// materialization, no CLI spawn. `help` and `doctor` stay on the CLI.
export {
  BRAIN_READ_COMMANDS,
  BRAIN_READ_PLANE_COMMANDS,
  BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  BRAIN_TOOL_FLAG_VALUE_JSON_SCHEMA,
};

export type BrainMultiBrainTarget = {
  brainRef: string;
  brainName: string;
};

// Single-brain surfaces use the shared read-tool schema unchanged; when
// several brains are in scope the model must pick one per call via a required
// `brain` enum (one tool, not N mangled tool names).
export function buildBrainMultiBrainToolSchema(brains: readonly BrainMultiBrainTarget[]) {
  if (brains.length <= 1) return BRAIN_READ_TOOL_INPUT_JSON_SCHEMA;
  return {
    ...BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
    properties: {
      ...BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.properties,
      brain: {
        type: "string",
        enum: brains.map((brain) => brain.brainRef),
        description: `Which brain to search. ${brains
          .map((brain) => `${brain.brainName}: ${brain.brainRef}`)
          .join("; ")}`,
      },
    },
    required: [...BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.required, "brain"],
  };
}

export function normalizeBrainReadToolInput(input: unknown): BrainToolInput {
  return normalizeSharedBrainReadToolInput(input) as BrainToolInput;
}
