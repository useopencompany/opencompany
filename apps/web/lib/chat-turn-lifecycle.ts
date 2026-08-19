import type { ConversationRuntimeStatus, RunStatus } from "@opencompany/core";

export type ActiveChatTurn = {
  conversationId: string;
  runId: string | null;
  assistantMessageId: string | null;
  startedAtMs: number;
};

export type ChatTurnPhase = "idle" | "submitting" | RunStatus;

type TerminalChatTurnPhase = Extract<ChatTurnPhase, "completed" | "failed" | "canceled">;

export function deriveChatTurnPhase(input: {
  runStatus: RunStatus | null;
  finalizedAssistantOutcome: TerminalChatTurnPhase | null;
  runtimeStatus: ConversationRuntimeStatus | null;
  runtimeMatchesTurn: boolean;
  transportStatus: "ready" | "submitted" | "streaming" | "error";
  submitting: boolean;
}): ChatTurnPhase {
  if (
    input.runStatus === "completed" ||
    input.runStatus === "failed" ||
    input.runStatus === "canceled"
  ) {
    return input.runStatus;
  }
  if (input.finalizedAssistantOutcome) return input.finalizedAssistantOutcome;
  if (input.runStatus === "paused") return "paused";
  if (input.runStatus === "running") return "running";
  if (input.runStatus === "queued") return "queued";

  if (input.runtimeMatchesTurn) {
    if (input.runtimeStatus === "queued") return "queued";
    if (input.runtimeStatus === "starting" || input.runtimeStatus === "running") {
      return "running";
    }
  }

  if (input.submitting || input.transportStatus === "submitted") return "submitting";
  if (input.transportStatus === "streaming") return "running";
  return "idle";
}

export function isChatTurnWorking(phase: ChatTurnPhase) {
  return phase === "submitting" || phase === "queued" || phase === "running";
}

export function isChatTurnTerminal(
  phase: ChatTurnPhase,
): phase is Extract<ChatTurnPhase, "completed" | "failed" | "canceled"> {
  return phase === "completed" || phase === "failed" || phase === "canceled";
}
