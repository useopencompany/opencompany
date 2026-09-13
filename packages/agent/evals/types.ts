import type { ActionDescriptor } from "@opencompany/agent-runtime";
import type { ModelMessage } from "ai";
import type { ProductChatAgentDebugTrace } from "../src/chat-agent";

export type Variant = "v4" | "v5";
export type Budgets = {
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
};
export type Execution = {
  action: string;
  params: Record<string, unknown>;
  valid: boolean;
  schemaVisible: boolean;
  approved: boolean;
  success: boolean;
};
export type ToolEvent = {
  name: string;
  input: unknown;
  output: unknown;
};
export type Evidence = {
  final: string;
  executions: Execution[];
  tools: ToolEvent[];
  approvals: { executionsBeforeApproval: number; count: number }[];
};
export type Scenario = {
  id: string;
  tags: string[];
  prompt: string;
  budgets: Budgets;
  allowedActions: string[];
  approvalAction?: string;
  history?: (variant: Variant, actions: ActionDescriptor[]) => ModelMessage[];
  previsible?: string[];
  fixture: (action: string, params: Record<string, unknown>) => unknown;
  assert: (evidence: Evidence) => Record<string, boolean>;
};
export type Trial = Evidence & {
  scenario: string;
  scenarioFingerprint: string;
  model: string;
  provider: string;
  variant: Variant;
  repeat: number;
  attempt: number;
  fingerprint: string;
  status: "passed" | "failed" | "interrupted";
  failures: string[];
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  knownCostUsd: number;
  durationMs: number;
  steps: number;
  toolCalls: number;
  invalidArguments: number;
  debugTrace: ProductChatAgentDebugTrace | null;
};
export const DEFAULT_BUDGETS: Budgets = {
  steps: 8,
  toolCalls: 12,
  inputTokens: 160_000,
  outputTokens: 16_384,
  costUsd: 2,
  durationMs: 240_000,
};
