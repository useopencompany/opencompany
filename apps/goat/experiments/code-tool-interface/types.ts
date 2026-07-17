export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export type MockTool = {
  path: string;
  integration: string;
  operation: string;
  summary: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
};

export type SearchResult = {
  path: string;
  summary: string;
  score: number;
};

export type CatalogTraceEvent = {
  at: string;
  kind: "search" | "describe" | "invoke" | "invoke_error";
  path?: string;
  query?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  errorKind?: SandboxFailureKind;
  durationMs: number;
};

export type BenchmarkStrategy = "execute" | "flat" | "tiered";

export type BenchmarkTask = {
  id: string;
  title: string;
  prompt: string;
  minToolCalls: number;
  requiredTools: string[];
  anyOfTools?: string[][];
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type SandboxFailureKind =
  | "syntax"
  | "timeout"
  | "unknown_tool"
  | "invalid_input"
  | "tool_error"
  | "runtime"
  | "protocol";

export type SandboxResult = {
  ok: boolean;
  value?: unknown;
  error?: string;
  stack?: string;
  failureKind?: SandboxFailureKind;
  logs: Array<{ level: "log" | "warn" | "error"; values: unknown[] }>;
  durationMs: number;
};

export type BenchmarkRun = {
  schemaVersion: "goat.code-tool-interface.run.v1";
  taskId: string;
  taskTitle: string;
  strategy: BenchmarkStrategy;
  model: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  failureReasons: string[];
  modelRoundTrips: number;
  toolRoundTrips: number;
  usage: TokenUsage;
  usagePerTurn: TokenUsage[];
  searchedQueries: string[];
  describedTools: string[];
  invokedTools: string[];
  overfetchCount: number;
  code?: string;
  sandbox?: SandboxResult;
  finalText: string;
  trace: CatalogTraceEvent[];
};

export type BenchmarkFile = {
  schemaVersion: "goat.code-tool-interface.benchmark.v1";
  createdAt: string;
  model: string;
  repeats: number;
  catalog: { integrations: number; tools: number };
  runs: BenchmarkRun[];
};
