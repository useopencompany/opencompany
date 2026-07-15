import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { normalizeGoatModel } from "@/lib/model-options";

export const GOAT_CHAT_PROMPT_MAX_LENGTH = 10_000;

// Shared between the chat route's 402 response and the client's error
// handler, which matches on it to render the add-credits action.
export const GOAT_CHAT_OUT_OF_CREDITS_MESSAGE =
  "Your workspace is out of credits. Add credits in Settings → Billing to keep chatting.";

export type GoatChatInput = {
  prompt: string;
  model: AgentModelId;
  sessionId: string | null;
};

export function validateGoatChatInput(input: {
  prompt: unknown;
  model: unknown;
  sessionId?: unknown;
  // Attachment-only sends are allowed: the file parts carry the payload.
  hasAttachments?: boolean;
}): { ok: true; value: GoatChatInput } | { ok: false; error: string } {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt && !input.hasAttachments) {
    return { ok: false, error: "Enter a message before sending." };
  }
  if (prompt.length > GOAT_CHAT_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Messages can be at most ${GOAT_CHAT_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
    };
  }

  const rawSessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";

  return {
    ok: true,
    value: {
      prompt,
      model: normalizeGoatModel(input.model),
      sessionId: rawSessionId || null,
    },
  };
}
