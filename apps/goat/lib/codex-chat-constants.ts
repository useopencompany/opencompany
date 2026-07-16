import {
  CODEX_AGENT_MODEL_IDS,
  CODEX_DEFAULT_MODEL_ID,
  codexCliModelNameForModelId,
  isCodexModelId,
} from "@opencompany/agent-runtime";

export const CODEX_PICKER_VALUE = "codex" as const;
export const CODEX_CHAT_MODEL_IDS = CODEX_AGENT_MODEL_IDS;
export type CodexPickerValue = typeof CODEX_PICKER_VALUE;
export type CodexChatModelId = (typeof CODEX_CHAT_MODEL_IDS)[number];

export const CODEX_CHAT_DEFAULT_MODEL_ID = CODEX_DEFAULT_MODEL_ID as CodexChatModelId;
export const CODEX_CHAT_DEFAULT_MODEL =
  codexCliModelNameForModelId(CODEX_CHAT_DEFAULT_MODEL_ID) ?? "gpt-5.5";
export const CODEX_CHAT_PROMPT_MAX_LENGTH = 10_000;

export function normalizeCodexChatModelId(value: unknown): CodexChatModelId {
  return typeof value === "string" && isCodexModelId(value)
    ? (value as CodexChatModelId)
    : CODEX_CHAT_DEFAULT_MODEL_ID;
}

export function parseCodexChatModelId(value: unknown): CodexChatModelId | null {
  return typeof value === "string" && isCodexModelId(value) ? (value as CodexChatModelId) : null;
}
