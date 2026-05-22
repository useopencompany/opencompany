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
}): ResolvedAgentRuntimeConfig {
  const instructions = input.agent.instructions.trim() || "Help the user complete the task.";
  const context = [
    "You are an OpenCompany agent running in an isolated cloud sandbox.",
    "Use tools when you need to inspect or change files, run commands, or verify work.",
    "Keep command output concise and explain material changes to the user.",
    input.workspaceName ? `Workspace: ${input.workspaceName}` : null,
    input.sessionTitle ? `Session: ${input.sessionTitle}` : null,
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
