import type {
  BenchmarkTask,
  CatalogTraceEvent,
  JsonSchema,
  SandboxFailureKind,
  SandboxResult,
  TokenUsage,
} from "../code-tool-interface/types";

export type ToolEffect = "read" | "write";

export type LoadedToolContract = {
  path: string;
  summary: string;
  effect: ToolEffect;
  inputSchema: JsonSchema;
  inputTypeScript: string;
  outputTypeScript: string;
  inputExamples: Array<Record<string, unknown>>;
};

export type DiscoveryResult = {
  queries: string[];
  intents: Array<{
    query: string;
    effect: ToolEffect;
    candidatePaths: string[];
  }>;
  loadedPaths: string[];
  contracts: LoadedToolContract[];
  typeScriptDefinitions: string;
};

export type PolicyTraceEvent = {
  at: string;
  path: string;
  decision: "allow" | "deny";
  reason: string;
  effect?: ToolEffect;
};

export type ProgressiveSandboxFailureKind = SandboxFailureKind | "policy";

export type ProgressiveSandboxResult = Omit<SandboxResult, "failureKind"> & {
  failureKind?: ProgressiveSandboxFailureKind;
  invocationCount: number;
  policyTrace: PolicyTraceEvent[];
};

export type ProgressiveBenchmarkRun = {
  schemaVersion: "goat.progressive-typed-code.run.v1";
  taskId: string;
  taskTitle: string;
  model: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  failureReasons: string[];
  modelRoundTrips: number;
  toolRoundTrips: number;
  discoveryCalls: number;
  completionRepairs: number;
  executeAttempts: number;
  usage: TokenUsage;
  usagePerTurn: TokenUsage[];
  searchedQueries: string[];
  loadedTools: string[];
  invokedTools: string[];
  overfetchCount: number;
  codeAttempts: string[];
  sandboxAttempts: ProgressiveSandboxResult[];
  finalText: string;
  trace: CatalogTraceEvent[];
  policyTrace: PolicyTraceEvent[];
};

export type ProgressiveBenchmarkFile = {
  schemaVersion: "goat.progressive-typed-code.benchmark.v1";
  createdAt: string;
  model: string;
  repeats: number;
  catalog: { integrations: number; tools: number };
  tasks: BenchmarkTask[];
  runs: ProgressiveBenchmarkRun[];
};
