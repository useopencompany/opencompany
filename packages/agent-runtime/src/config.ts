import { getAgentModelRuntimeOptions, type ModelProviderOptions } from "./models";
import { resolveAgentSkillDefinitions } from "./skills";
import { type RuntimeToolName, resolveRuntimeToolNamesForConfigTools } from "./tools";
import type { AgentConfig } from "./types";

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
  const skills = resolveAgentSkillDefinitions(input.agent.skills);
  const context = [
    "You are an OpenCompany agent running in an isolated cloud sandbox.",
    "Use tools when you need to inspect or change files, run commands, or verify work.",
    "Avoid launching more than eight tool calls in one batch; inspect results before deciding whether more calls are useful.",
    "Keep command output concise and explain material changes to the user.",
    "The sandbox workspace root contains visible file roots: ./work for session-local files and scratch work, ./brain for mounted Brain context, and ./skills for lazily loaded skill instructions.",
    "File tools require paths prefixed with work/, brain/, or skills/. Bare paths like README.md are invalid; use work/README.md, brain/README.md, or skills/opencompany/SKILL.md.",
    input.agent.brain?.length
      ? `Brain files are mounted under ./brain for this session: ${input.agent.brain
          .map((reference) => formatBrainReferencePath(reference.path))
          .join(
            ", ",
          )}. Only edit files inside mounted brain paths when updating long-lived context.`
      : null,
    skills.length > 0
      ? `Available skills:\n<available_skills>\n${skills
          .map(
            (skill) =>
              `<skill name="${skill.name}" path="${skill.sandboxPath}">${skill.description}</skill>`,
          )
          .join(
            "\n",
          )}\n</available_skills>\nBefore work matching a skill description, read that skill's SKILL.md with read_file. Do not assume the full skill instructions are already in context.`
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
    tools: resolveRuntimeToolNamesForConfigTools(
      input.agent.tools,
      skills.map((skill) => skill.id),
    ),
  };
}

function formatBrainReferencePath(path: string) {
  return path === "/" ? "brain/" : path;
}
