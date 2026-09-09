import type { CodexChatSession } from "@opencompany/db/product-schema";
import { CodexChatRetryableInfrastructureError } from "./codex-chat-errors";
import { armSandboxIdleTimeoutById, connectSandbox } from "./sandbox";

// A crashed worker may leave a detached engine in the sandbox. Fence it even when
// recovery only needs to cancel or park an approval, without starting a new turn.
export async function fenceCodingSessionEngine(session: CodexChatSession, idleTimeoutMs: number) {
  if (!session.sandboxId || session.engine === "opencompany") return;
  try {
    const sandbox = await connectSandbox({ sandboxId: session.sandboxId });
    if (!sandbox) return;
    if (session.engine === "codex") {
      const { killLeftoverCodexTurnProcesses } = await import("./codex-cli");
      await killLeftoverCodexTurnProcesses(sandbox);
    } else {
      const { killLeftoverClaudeTurnProcesses } = await import("./claude-code-cli");
      await killLeftoverClaudeTurnProcesses(sandbox);
    }
    await armSandboxIdleTimeoutById(session.sandboxId, idleTimeoutMs);
  } catch (error) {
    throw new CodexChatRetryableInfrastructureError(
      "The previous coding engine could not be stopped before recovery.",
      error,
    );
  }
}
