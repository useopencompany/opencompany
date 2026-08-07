import { isCodexReasoningEffort } from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import type { CodexChatTurnSettings } from "@opencompany/db/schema";

// High is the balanced Claude Code default for capable coding work. Keeping it explicit makes the
// composer and queued turn agree, while each invocation can still override it with --effort.
export const DEFAULT_CLAUDE_CHAT_REASONING_EFFORT: CodexReasoningEffort = "high";

export function parseClaudeChatSettings(
  value: unknown,
): { ok: true; settings: CodexChatTurnSettings } | { ok: false; error: string } {
  if (value == null) {
    return {
      ok: true,
      settings: { reasoningEffort: DEFAULT_CLAUDE_CHAT_REASONING_EFFORT },
    };
  }
  if (!isRecord(value)) return { ok: false, error: "Invalid Claude settings." };
  if (typeof value.reasoningEffort !== "string" || !isCodexReasoningEffort(value.reasoningEffort)) {
    return { ok: false, error: "Invalid Claude reasoning effort." };
  }
  return { ok: true, settings: { reasoningEffort: value.reasoningEffort } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
