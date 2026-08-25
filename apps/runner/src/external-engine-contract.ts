export type ExternalEngineUsage = {
  input_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens: number;
};

export type ExternalEngineGoalSummary = {
  objective: string | null;
  status: string | null;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
};

export type ExternalEngineTurnSummary = {
  sessionId: string | null;
  status: "success" | "error" | "timeout" | "unknown";
  result: string;
  error: string | null;
  usage: ExternalEngineUsage | null;
  goal: ExternalEngineGoalSummary | null;
};

export type ExternalEngineRequest = {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
};

export type ExternalEngineToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
};

export type ExternalEngineToolResponse = {
  success: boolean;
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
};

export type ExternalEngineToolCall = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
};

export type ExternalEngineTool = {
  spec: ExternalEngineToolSpec;
  execute: (call: ExternalEngineToolCall) => Promise<ExternalEngineToolResponse>;
};
