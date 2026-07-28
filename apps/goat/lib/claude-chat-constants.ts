import {
  CLAUDE_CODE_AGENT_MODEL_IDS,
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  claudeCodeCliModelNameForModelId,
  isClaudeCodeModelId,
} from "@opencompany/agent-runtime";

export const CLAUDE_PICKER_VALUE = "claude_code" as const;
export const CLAUDE_CHAT_MODEL_IDS = CLAUDE_CODE_AGENT_MODEL_IDS;
export type ClaudePickerValue = typeof CLAUDE_PICKER_VALUE;
export type ClaudeChatModelId = (typeof CLAUDE_CHAT_MODEL_IDS)[number];

export const CLAUDE_CHAT_DEFAULT_MODEL_ID = CLAUDE_CODE_DEFAULT_MODEL_ID as ClaudeChatModelId;
export const CLAUDE_CHAT_DEFAULT_MODEL =
  claudeCodeCliModelNameForModelId(CLAUDE_CHAT_DEFAULT_MODEL_ID) ?? "claude-sonnet-5";

export function parseClaudeChatModelId(value: unknown): ClaudeChatModelId | null {
  return typeof value === "string" && isClaudeCodeModelId(value)
    ? (value as ClaudeChatModelId)
    : null;
}
