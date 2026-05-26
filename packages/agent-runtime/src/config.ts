import type { AgentConfig } from "@opencompany/db/schema";
import { getAgentModelRuntimeOptions, type ModelProviderOptions } from "./models";
import { type RuntimeToolName, resolveRuntimeToolNamesForConfigTools } from "./tools";

export type ResolvedAgentRuntimeConfig = {
  systemPrompt: string;
  model: {
    provider: "vercel-ai-gateway";
    name: string;
    supportsReasoning: boolean;
    providerOptions?: ModelProviderOptions;
    exposeReasoningSummary: boolean;
  };
  tools: RuntimeToolName[];
};

export function resolveAgentRuntimeConfig(input: {
  agent: AgentConfig;
  workspaceName?: string;
  sessionTitle?: string;
  userName?: string;
}): ResolvedAgentRuntimeConfig {
  const instructions = input.agent.instructions.trim() || "Help the user complete the task.";
  const context = [
    "You are an OpenCompany agent running in an isolated cloud sandbox.",
    "Use tools when you need to inspect or change files, run commands, or verify work.",
    "Keep command output concise and explain material changes to the user.",
    "The sandbox workspace root contains exactly two visible file roots: ./work for session-local files and scratch work, and ./brain for mounted Brain context.",
    "File tools require paths prefixed with work/ or brain/. Bare paths like README.md are invalid; use work/README.md or brain/README.md.",
    input.agent.brain?.length
      ? `Brain files are mounted under ./brain for this session: ${input.agent.brain
          .map((reference) => formatBrainReferencePath(reference.path))
          .join(
            ", ",
          )}. Only edit files inside mounted brain paths when updating long-lived context.`
      : null,
    input.workspaceName ? `Workspace: ${input.workspaceName}` : null,
    input.sessionTitle ? `Session: ${input.sessionTitle}` : null,
    input.userName ? `User: ${input.userName}` : null,
  ].filter(Boolean);

  const modelRuntime = getAgentModelRuntimeOptions(input.agent.model.name);

  return {
    systemPrompt: `${context.join("\n")}\n\nAgent instructions:\n${instructions}`,
    model: {
      provider: "vercel-ai-gateway",
      name: input.agent.model.name,
      supportsReasoning: modelRuntime.supportsReasoning,
      ...(modelRuntime.providerOptions ? { providerOptions: modelRuntime.providerOptions } : {}),
      exposeReasoningSummary: modelRuntime.exposeReasoningSummary,
    },
    tools: resolveRuntimeToolNamesForConfigTools(input.agent.tools),
  };
}

function formatBrainReferencePath(path: string) {
  return path === "/" ? "brain/" : path;
}
