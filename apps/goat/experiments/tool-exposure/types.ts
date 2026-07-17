export type JsonSchema = {
  type: "object";
  additionalProperties: false;
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: { type: "string" | "number" };
  additionalProperties?: boolean;
};

export type MockToolDefinition = {
  name: string;
  shortDescription: string;
  inputSchema: JsonSchema;
  example: Record<string, unknown>;
  conventions: string[];
};

export type TriggerPattern = {
  label: string;
  regex: RegExp;
};

export type MockIntegration = {
  id: string;
  name: string;
  summary: string;
  pointer: string;
  triggerPatterns: TriggerPattern[];
  curatedToolNames: string[];
  tools: MockToolDefinition[];
  synthetic?: boolean;
};

export type ToolPointer = {
  integrationId: string;
  toolName: string;
  pointer: string;
};

export type ExpansionReason = {
  integrationId: string;
  integrationName: string;
  pattern: string;
  match: string;
};

export type TriggerResult = {
  expandedIntegrationIds: string[];
  reasons: ExpansionReason[];
  latencyMs: number;
};

export type BenchmarkTask = {
  id: string;
  category: "single" | "multi" | "recovery";
  prompt: string;
  expectedTools: ToolPointer[];
  expectedIntegrationIds: string[];
  triggerShouldExpand: string[];
  notes: string;
};

export type ExposureMode = "flat" | "tiered";

export type ExpansionTraceEvent = {
  sequence: number;
  level: 1 | 2;
  integrationId: string;
  toolName?: string;
  reason: "deterministic_trigger" | "model_request" | "call_time";
  detail: string;
};

export type ObservedToolCall = {
  integrationId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  valid: boolean;
  error?: string;
};

export type TaskScore = {
  exact: boolean;
  precision: number;
  recall: number;
  integrationRecall: number;
  missingTools: string[];
  unexpectedTools: string[];
};

export type StepMeasurement = {
  step: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelToolCalls: string[];
  expandedNodes: string[];
};

export type AgentCaseResult = {
  taskId: string;
  category: BenchmarkTask["category"];
  mode: ExposureMode;
  model: string;
  integrationCount: number;
  exposedCallableToolCount: number;
  registryToolCount: number;
  estimatedInitialContextTokens: number;
  deterministicTrigger: TriggerResult;
  steps: StepMeasurement[];
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  observedToolCalls: ObservedToolCall[];
  expansionTrace: ExpansionTraceEvent[];
  modelRequestedLevel2OutsideAuto: boolean;
  triggerFalseNegative: boolean;
  recoveredFromTriggerFalseNegative: boolean;
  score: TaskScore;
  finalText: string;
  error?: string;
};

export type BenchmarkRun = {
  schemaVersion: "goat.tool-exposure-benchmark.v1";
  createdAt: string;
  model: string;
  taskRepetitions: number;
  scaleIntegrationCounts: number[];
  environment: {
    runtime: string;
    platform: string;
    architecture: string;
  };
  mainSuite: AgentCaseResult[];
  scaleSuite: AgentCaseResult[];
};
