export type AdaptiveSideEffect = "read" | "write" | "destructive" | "external_communication";

export type AdaptiveToolDefinition = {
  name: string;
  pointer: string;
  description: string;
  operationAliases: string[];
  objectAliases: string[];
  sideEffect: AdaptiveSideEffect;
  outputKind: string;
  inputSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  popularity: number;
};

export type AdaptiveIntegrationDefinition = {
  id: string;
  name: string;
  summary: string;
  pointer: string;
  aliases: string[];
  keywords: string[];
  tools: AdaptiveToolDefinition[];
};

export type ActivationReason = {
  kind: "explicit" | "keyword" | "pattern" | "operation" | "object" | "lexical" | "fallback";
  matched: string;
  score: number;
};

export type ActivatedToolCard = {
  pointer: string;
  name: string;
  description: string;
  signature: string;
  sideEffect: AdaptiveSideEffect;
  outputKind: string;
  score: number;
  matchedClauses: number[];
  reasons: ActivationReason[];
};

export type ActivatedIntegration = {
  id: string;
  name: string;
  summary: string;
  pointer: string;
  score: number;
  reasons: ActivationReason[];
  tools: ActivatedToolCard[];
};

export type AdaptiveExposureSnapshot = {
  registryVersion: string;
  query: string;
  clauses: string[];
  integrationCount: number;
  registryToolCount: number;
  activatedIntegrationCount: number;
  candidateToolCount: number;
  activationLatencyMs: number;
  estimatedAdaptiveTokens: number;
  estimatedFlatTokens: number;
  estimatedReductionPercent: number;
  level0: Array<{
    id: string;
    name: string;
    summary: string;
    pointer: string;
    activated: boolean;
  }>;
  integrations: ActivatedIntegration[];
};

export type AdaptiveExpansionEvent = {
  sequence: number;
  level: 1 | 2;
  pointer: string;
  reason: "model_request" | "call_time";
};

export type AdaptiveObservedCall = {
  pointer: string;
  integrationId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  valid: boolean;
  error?: string;
  result?: unknown;
};

export type AdaptiveStepMeasurement = {
  step: number;
  inputTokens: number | null;
  outputTokens: number | null;
  modelToolCalls: string[];
};

export type AdaptiveAgentRun = {
  model: string;
  finalText: string;
  durationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  steps: AdaptiveStepMeasurement[];
  calls: AdaptiveObservedCall[];
  expansions: AdaptiveExpansionEvent[];
};

export type AdaptiveExperimentResponse = {
  mode: "analyze" | "agent";
  snapshot: AdaptiveExposureSnapshot;
  run?: AdaptiveAgentRun;
};
