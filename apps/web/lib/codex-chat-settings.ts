// Re-export shim: source moved to @opencompany/agent (shared with the runner).
import { CLAUDE_CODE_DEFAULT_REASONING_EFFORT } from "@opencompany/agent-runtime";

export * from "@opencompany/agent/codex-chat-settings";

export const DEFAULT_CLAUDE_CHAT_REASONING_EFFORT = CLAUDE_CODE_DEFAULT_REASONING_EFFORT;
