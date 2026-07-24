import {
  GOAT_BRAIN_READ_COMMANDS,
  GOAT_BRAIN_RETRIEVAL_COMMANDS as GOAT_BRAIN_READ_PLANE_COMMANDS,
  GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  GOAT_BRAIN_TOOL_FLAG_VALUE_JSON_SCHEMA,
  normalizeGoatBrainReadToolInput as normalizeSharedGoatBrainReadToolInput,
} from "@opencompany/goat-brain";
import type { GoatBrainToolInput } from "@/lib/chat-ui";

// Shared read-only Goat Brain tool surface for main chat and the per-brain MCP connector.
// Keep command and input normalization here so both consumers expose the same retrieval contract.
// Commands served by the DB read plane (@opencompany/db/goat-brain-read): indexed SQL, no brain
// materialization, no CLI spawn. `help` and `doctor` stay on the CLI.
export {
  GOAT_BRAIN_READ_COMMANDS,
  GOAT_BRAIN_READ_PLANE_COMMANDS,
  GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  GOAT_BRAIN_TOOL_FLAG_VALUE_JSON_SCHEMA,
};

export type GoatBrainMultiBrainTarget = {
  brainRef: string;
  brainName: string;
};

// Single-brain surfaces use the shared read-tool schema unchanged; when
// several brains are in scope the model must pick one per call via a required
// `brain` enum (one tool, not N mangled tool names).
export function buildGoatBrainMultiBrainToolSchema(brains: readonly GoatBrainMultiBrainTarget[]) {
  if (brains.length <= 1) return GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA;
  return {
    ...GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
    properties: {
      ...GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.properties,
      brain: {
        type: "string",
        enum: brains.map((brain) => brain.brainRef),
        description: `Which brain to search. ${brains
          .map((brain) => `${brain.brainName}: ${brain.brainRef}`)
          .join("; ")}`,
      },
    },
    required: [...GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.required, "brain"],
  };
}

export function normalizeGoatBrainReadToolInput(input: unknown): GoatBrainToolInput {
  return normalizeSharedGoatBrainReadToolInput(input) as GoatBrainToolInput;
}
