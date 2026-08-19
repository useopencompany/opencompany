export type HarnessEventType =
  | "assistant.delta"
  | "assistant.completed"
  | "reasoning.completed"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "command.failed"
  | "file_change.started"
  | "file_change.completed"
  | "mcp_tool.started"
  | "mcp_tool.completed"
  | "subagent.started"
  | "subagent.completed"
  | "dynamic_tool.started"
  | "dynamic_tool.completed"
  | "web_search.started"
  | "web_search.completed"
  | "plan.updated"
  | "goal.updated"
  | "question.requested"
  | "approval.requested"
  | "turn.started"
  | "turn.completed"
  | "usage.updated"
  | "error"
  | "unknown";

export type HarnessNormalizedEvent = {
  type: HarnessEventType;
  payload: Record<string, unknown>;
  rawEvent: Record<string, unknown>;
};

export interface Harness<TInput, TResult> {
  runTurn(input: TInput): Promise<TResult>;
}
