import type { ChatPresentationPublisher } from "@opencompany/chat-presentation";
import type {
  CodexChatEngine,
  CodexChatSession,
  CodexChatTurn,
} from "@opencompany/db/product-schema";
import { runClaudeCodeChatTurn } from "./claude-code-chat";
import { runCodexChatTurn } from "./codex-chat";
import type { RunnerEnv } from "./env";
import { runProductChatTurn } from "./opencompany-chat";
import type { TaskTurnContext } from "./task-turn";

export type CodingEngineTurnInput = {
  turn: CodexChatTurn;
  session: CodexChatSession;
  env: RunnerEnv;
  taskContext?: TaskTurnContext | undefined;
  canonicalAttemptId?: string;
  presentationPublisher?: ChatPresentationPublisher;
  recovery?: { reason: "lease_reclaimed" | "cross_deploy" };
  shouldAbort?: () => Error | null;
};

export type CodingEngineTurnOutcome = "settled" | "handed_off";
export type CodingEngineTurnRunner = (
  input: CodingEngineTurnInput,
) => Promise<CodingEngineTurnOutcome>;

export const CODING_ENGINE_REGISTRY: Readonly<Record<CodexChatEngine, CodingEngineTurnRunner>> = {
  opencompany: (input) => runProductChatTurn(input),
  claude_code: (input) => runClaudeCodeChatTurn(input),
  codex: (input) => runCodexChatTurn(input),
};

export function runCodingEngineTurn(input: CodingEngineTurnInput) {
  return CODING_ENGINE_REGISTRY[input.session.engine](input);
}
