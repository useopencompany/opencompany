import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { ToolSet } from "ai";

export type GoatCapabilityId = "slack" | "linear" | "youtube_transcript";

// The maximum side effect a capability may perform. A write-capable
// capability still supports read calls, but write tools are exposed only when
// the dispatcher explicitly selects a write operation.
export type GoatCapabilitySideEffect = "read" | "write";
export type GoatCapabilityOperation = GoatCapabilitySideEffect;

export type GoatCapabilityEntity = {
  type: string;
  id: string;
  url?: string;
  title?: string;
};

export type GoatCapabilityErrorCode =
  | "not_connected"
  | "auth_expired"
  | "timeout"
  | "step_cap"
  | "call_budget"
  | "provider_error"
  | "invalid_request"
  | "empty_result"
  | "internal";

// The only shape that ever crosses back into the main chat context. Raw
// provider payloads stay inside the worker; the envelope is the contract.
export type GoatCapabilityEnvelope = {
  summary: string;
  entities: GoatCapabilityEntity[];
  error?: { code: GoatCapabilityErrorCode; hint: string };
};

export type GoatCapabilityWorkerContext = {
  userWorkosId: string;
  signal: AbortSignal;
  currentDate: Date;
  operation: GoatCapabilityOperation;
  userContext: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    timezone: string;
  };
};

export type GoatCapabilityToolkit = {
  tools: ToolSet;
  close?: () => Promise<void>;
};

// What resolution produces for an available capability: the index line for the
// system prompt plus everything the worker needs, with connection specifics
// (team domain, scope-dependent tools, ...) already bound in.
export type ResolvedGoatCapability = {
  id: GoatCapabilityId;
  sideEffect: GoatCapabilitySideEffect;
  workerModel: AgentModelId;
  indexLine: string;
  recipeLines: readonly string[];
  createTools: (context: GoatCapabilityWorkerContext) => Promise<GoatCapabilityToolkit>;
};

export type GoatCapabilityDefinition = {
  id: GoatCapabilityId;
  sideEffect: GoatCapabilitySideEffect;
  workerModel: AgentModelId;
  // Returns null when the capability is unavailable for this user (not
  // connected, env key missing). Unavailable capabilities are absent from both
  // the prompt index and the dispatch enum — they don't exist to the model.
  resolve: (
    userWorkosId: string,
  ) => Promise<Omit<ResolvedGoatCapability, "id" | "sideEffect" | "workerModel"> | null>;
};

export type GoatCapabilityTranscriptEntry = {
  tool: string;
  durationMs: number;
  inputPreview: string;
  outputPreview: string;
};

export type GoatCapabilityCallDebug = {
  capability: string;
  operation: GoatCapabilityOperation;
  workerModel: string;
  steps: number;
  durationMs: number;
  outcome: "success" | "partial" | "error";
  errorCode?: GoatCapabilityErrorCode;
  transcript: GoatCapabilityTranscriptEntry[];
};

// Thrown by capability tool factories when the stored connection cannot
// authenticate; the worker maps it to an auth_expired envelope.
export class GoatCapabilityAuthError extends Error {
  readonly code: Extract<GoatCapabilityErrorCode, "not_connected" | "auth_expired">;

  constructor(
    code: Extract<GoatCapabilityErrorCode, "not_connected" | "auth_expired">,
    message: string,
  ) {
    super(message);
    this.name = "GoatCapabilityAuthError";
    this.code = code;
  }
}
