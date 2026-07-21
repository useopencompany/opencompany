// Shim: the Goat Brain chat-tool runner moved to @opencompany/goat-agent so
// apps/runner can use it too. This binds the app-specific MCP-setup completion
// check; the exported surface is unchanged.
import {
  runGoatBrainCliForUser as runGoatBrainCliForUserWithDeps,
  runGoatBrainToolForUser as runGoatBrainToolForUserWithDeps,
} from "@opencompany/goat-agent/brain-read-tool";
import type { GoatBrainToolOutput } from "@/lib/chat-ui";
import { isGoatMcpSetupCompletionRun } from "@/lib/mcp-setup";

export { renderGoatBrainToolCommand } from "@opencompany/goat-agent/brain-read-tool";

export async function runGoatBrainCliForUser(
  input: Omit<Parameters<typeof runGoatBrainCliForUserWithDeps>[0], "completesMcpSetup">,
): Promise<GoatBrainToolOutput> {
  return runGoatBrainCliForUserWithDeps({
    ...input,
    completesMcpSetup: isGoatMcpSetupCompletionRun,
  });
}

export async function runGoatBrainToolForUser(
  input: Omit<Parameters<typeof runGoatBrainToolForUserWithDeps>[0], "completesMcpSetup">,
): Promise<GoatBrainToolOutput> {
  return runGoatBrainToolForUserWithDeps({
    ...input,
    completesMcpSetup: isGoatMcpSetupCompletionRun,
  });
}
